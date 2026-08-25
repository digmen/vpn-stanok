import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NodeSSH } from 'node-ssh';
import { REMOTE, SSH } from './constants.js';

const execFileP = promisify(execFile);

function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Владелец добавляет ВТОРОЙ (третий, ...) сервер через станок, когда у него уже
 * есть работающий бот-продавец на другом узле (primary). Вместо второй копии
 * бота с тем же токеном (баг 25.08 — 409 Conflict, ловили дважды на живом клиенте:
 * Германия, потом Амстердам) кладём новый сервер локацией ПРЯМО в данные уже
 * работающего бота на primary. Перезапуск primary не нужен — seller-bot/locations.ts
 * перечитывает locations.json на каждый вызов, новая точка подхватится сама.
 *
 * Две пары ключей рождаются на новом сервере:
 * 1. Для самого seller-bot (кладём в его data-папку на primary) — им бот будет
 *    сам выдавать/отзывать VPN-пиры на этом сервере, тем же путём, что и остальные
 *    его локации (vpn.ts::createVpnPeerAt).
 * 2. Для станка (техподдержка) — сохраняется в БД (encrypted), чтобы дальше не
 *    просить пароль повторно: он мог уже смениться, а ключ — не сменится сам по себе.
 */
export interface AttachLocationOpts {
  newHost: string;
  newPassword: string;
  newPort?: number;
  primaryHost: string;
  primaryPassword: string;
  /** Как назвать локацию у клиентов — по умолчанию сам адрес. */
  title?: string;
}

export interface AttachLocationResult {
  locationId: string;
  /** Приватный ключ станка для будущей техподдержки этого сервера — сохранить encrypted в БД. */
  supportPrivateKey: string;
}

async function generateKeypair(comment: string): Promise<{ priv: string; pub: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'stanok-key-'));
  const file = path.join(dir, 'id');
  try {
    await execFileP('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 30_000 });
    return { priv: readFileSync(file, 'utf8'), pub: readFileSync(file + '.pub', 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function installPubKey(ssh: NodeSSH, pub: string): Promise<void> {
  const cmd =
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
    `grep -qxF ${quote(pub)} ~/.ssh/authorized_keys || echo ${quote(pub)} >> ~/.ssh/authorized_keys`;
  const res = await ssh.execCommand(cmd);
  if (res.code !== 0) throw new Error('не удалось прописать ключ доступа: ' + (res.stderr || res.stdout).slice(0, 200));
}

export async function attachLocationToPrimary(opts: AttachLocationOpts): Promise<AttachLocationResult> {
  // 1. Заходим на НОВЫЙ сервер паролем, ставим ОБА публичных ключа.
  const newSsh = new NodeSSH();
  await newSsh.connect({
    host: opts.newHost,
    username: SSH.USERNAME,
    password: opts.newPassword,
    port: opts.newPort ?? SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true,
  });
  let locationKey: { priv: string; pub: string };
  let supportKey: { priv: string; pub: string };
  try {
    locationKey = await generateKeypair('seller-bot-location');
    supportKey = await generateKeypair('stanok-support');
    await installPubKey(newSsh, locationKey.pub);
    await installPubKey(newSsh, supportKey.pub);
  } finally {
    newSsh.dispose();
  }

  // 2. Заходим на PRIMARY (паролем — он уже там, seller-bot развёрнут им же) и
  //    кладём приватный ключ локации + вызываем CLI-скрипт самого seller-bot,
  //    чтобы формат locations.json/data-папки не дублировать здесь второй раз.
  const primarySsh = new NodeSSH();
  await primarySsh.connect({
    host: opts.primaryHost,
    username: SSH.USERNAME,
    password: opts.primaryPassword,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true,
  });
  try {
    const remoteKeyPath = `/tmp/stanok-loc-${Date.now()}.key`;
    await primarySsh.execCommand(`cat > ${remoteKeyPath} <<'KEYEOF'\n${locationKey.priv}KEYEOF\nchmod 600 ${remoteKeyPath}`);
    const args = [opts.newHost, String(opts.newPort ?? ''), remoteKeyPath, opts.title ?? opts.newHost]
      .map(quote)
      .join(' ');
    const res = await primarySsh.execCommand(`cd ${REMOTE.SELLER_DIR} && npx tsx scripts/cli-add-location.ts ${args}`);
    await primarySsh.execCommand(`rm -f ${remoteKeyPath}`).catch(() => {});
    if (res.code !== 0) {
      throw new Error('не удалось добавить локацию в бота: ' + (res.stderr || res.stdout).slice(0, 300));
    }
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { id?: string };
    if (!parsed.id) throw new Error('cli-add-location не вернул id: ' + res.stdout.slice(0, 200));
    return { locationId: parsed.id, supportPrivateKey: supportKey.priv };
  } finally {
    primarySsh.dispose();
  }
}
