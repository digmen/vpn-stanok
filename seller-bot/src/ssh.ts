import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NodeSSH } from 'node-ssh';
import { SSH } from './constants.js';
import { keyPath, type RemoteLocation } from './locations.js';

const execFileP = promisify(execFile);

function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function connectWithPassword(
  host: string,
  user: string,
  password: string,
  port: number = SSH.PORT,
): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host,
    username: user,
    password,
    port,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    // Многие серверы принимают пароль только через keyboard-interactive —
    // та же причина, что и в станке (stanok-bot/src/ssh.ts).
    tryKeyboard: true,
  });
  return ssh;
}

async function connectWithKey(loc: RemoteLocation): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: loc.host,
    username: loc.user,
    privateKeyPath: keyPath(loc.keyFile),
    port: loc.port ?? SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
  });
  return ssh;
}

/** Генерирует пару ключей локально через ssh-keygen. Возвращает {private, public}. */
async function generateKeypair(): Promise<{ priv: string; pub: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sellerkey-'));
  const file = path.join(dir, 'id');
  try {
    // ed25519: короткий ключ, быстрый, поддерживается всеми живыми серверами.
    // -N '' — без пароля: бот должен уметь ходить сам, без участия человека.
    await execFileP('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'seller-bot', '-f', file], {
      timeout: 30_000,
    });
    return {
      priv: readFileSync(file, 'utf8'),
      pub: readFileSync(file + '.pub', 'utf8').trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Переводит ошибку подключения на человеческий и подсказывает, что делать.
 *
 * Причина (23.08): владелец увидел голое «Timed out while waiting for
 * handshake» и не понял ни что сломалось, ни куда смотреть. Сообщение об
 * ошибке — часть продукта: если оно не говорит, что чинить, человек просто
 * бросает добавление сервера.
 */
function explainConnectError(e: unknown, host: string, port: number): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim();
  const low = raw.toLowerCase();
  const where = `${host}:${port}`;

  if (low.includes('timed out') || low.includes('timeout') || low.includes('etimedout')) {
    return (
      `Сервер ${where} не отвечает на SSH.\n\n` +
      'Скорее всего одно из двух:\n' +
      `• SSH висит не на порту ${port} — пришли адрес с портом, например ${host}:2222\n` +
      '• порт закрыт файрволом — открой его (ufw allow) или спроси хостера\n\n' +
      'Сам сервер при этом может быть жив — проверяется это разными вещами.'
    );
  }
  if (low.includes('econnrefused')) {
    return `Сервер ${where} ответил «соединение отклонено» — на этом порту SSH не слушает. Проверь порт.`;
  }
  if (low.includes('all configured authentication methods failed')) {
    return 'Сервер ответил, но пароль не подошёл. Проверь, что это root-пароль именно от этого сервера.';
  }
  if (low.includes('enotfound') || low.includes('eai_again')) {
    return `Адрес ${host} не находится — проверь, нет ли опечатки.`;
  }
  return raw.slice(0, 400);
}

export interface AttachResult {
  privateKey: string;
  /** Что нашлось на сервере — чтобы сказать владельцу человеческим языком. */
  amneziaInstalled: boolean;
}

/**
 * Первый заход на новый сервер: проверяем доступ и наличие VPN, ставим свой
 * ключ и возвращаем его. Пароль после этого нигде не сохраняется — см.
 * комментарий у saveKey() в locations.ts.
 */
export async function attachServer(
  host: string,
  user: string,
  password: string,
  port: number = SSH.PORT,
): Promise<AttachResult> {
  const ssh = await connectWithPassword(host, user, password, port).catch((e: unknown) => {
    throw new Error(explainConnectError(e, host, port));
  });
  try {
    // Есть ли вообще AmneziaWG. Ставить его отсюда пока не умеем (это делает
    // станок при заведении узла) — поэтому честно сообщаем, а не молча
    // добавляем сервер, с которого ключи не выдадутся.
    const check = await ssh.execCommand(
      'test -f /etc/amnezia/amneziawg/awg0.conf && command -v awg >/dev/null 2>&1 && echo OK || echo NO',
    );
    const amneziaInstalled = check.stdout.trim().endsWith('OK');

    const { priv, pub } = await generateKeypair();
    // Кладём свой ключ в authorized_keys, не затирая чужие.
    const install =
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
      `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
      `grep -qxF ${quote(pub)} ~/.ssh/authorized_keys || echo ${quote(pub)} >> ~/.ssh/authorized_keys`;
    const res = await ssh.execCommand(install);
    if (res.code !== 0) {
      throw new Error('не удалось прописать ключ доступа: ' + (res.stderr || res.stdout).slice(0, 200));
    }
    return { privateKey: priv, amneziaInstalled };
  } finally {
    ssh.dispose();
  }
}

/**
 * Заливает локальный скрипт на сервер и выполняет его, возвращая stdout.
 * Используется и для выдачи пира, и для отзыва — оба скрипта уже лежат
 * в scripts/ и рассчитаны на запуск от root на самом узле.
 */
export async function runScript(
  loc: RemoteLocation,
  localScriptPath: string,
  args: string[] = [],
  timeoutMs = 60_000,
): Promise<string> {
  const ssh = await connectWithKey(loc);
  const remotePath = `/tmp/seller-${path.basename(localScriptPath)}`;
  try {
    await ssh.putFile(localScriptPath, remotePath);
    const cmd = `bash ${remotePath} ${args.map(quote).join(' ')}`;
    const res = await Promise.race([
      ssh.execCommand(cmd),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('таймаут выполнения на сервере')), timeoutMs)),
    ]);
    if (res.code !== 0) {
      throw new Error((res.stderr || res.stdout || 'скрипт завершился с ошибкой').slice(0, 400));
    }
    return res.stdout;
  } finally {
    // Скрипт за собой убираем: в /tmp чужого сервера мусор оставлять незачем
    await ssh.execCommand(`rm -f ${remotePath}`).catch(() => {});
    ssh.dispose();
  }
}

/** Быстрая проверка «сервер жив и ключ ещё работает» — для экрана локаций. */
export async function ping(loc: RemoteLocation): Promise<boolean> {
  try {
    const ssh = await connectWithKey(loc);
    try {
      const r = await ssh.execCommand('echo ok');
      return r.stdout.trim() === 'ok';
    } finally {
      ssh.dispose();
    }
  } catch {
    return false;
  }
}
