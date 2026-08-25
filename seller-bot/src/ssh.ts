import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NodeSSH } from 'node-ssh';
import { INSTALL_SCRIPT_TIMEOUT_MS, SSH } from './constants.js';
import { keyPath, type RemoteLocation } from './locations.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Тот же обкатанный установщик, что и у станка при заведении узла (ждёт
// apt-lock, чинит Astra/Debian-производные, headless). Своя копия в seller-bot —
// чтобы бот был самодостаточен на сервере франчайзи, без похода в станок.
const INSTALL_SCRIPT = path.resolve(__dirname, '../scripts/install-amneziawg.sh');

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
  /** VPN готов к концу вызова: был на сервере или мы его поставили. */
  amneziaReady: boolean;
  /** Ставили ли VPN в этот заход — чтобы сказать владельцу человеческим языком. */
  installedNow: boolean;
}

/**
 * Первый заход на новый сервер: проверяем доступ, ставим свой ключ и —
 * если VPN на сервере ещё нет — ставим его сами тем же установщиком, что и
 * станок. Так франчайзи может подключить хоть 100 голых VPS одним своим ботом,
 * не заводя каждый через станок (решение Жони 25.08 — bring-your-own-server).
 * Пароль после этого нигде не сохраняется — см. комментарий у saveKey().
 *
 * onProgress зовём на долгих шагах (установка VPN идёт минутами) — владельцу
 * важно видеть, что бот работает, а не завис.
 */
export async function attachServer(
  host: string,
  user: string,
  password: string,
  port: number = SSH.PORT,
  onProgress?: (text: string) => void | Promise<void>,
): Promise<AttachResult> {
  const ssh = await connectWithPassword(host, user, password, port).catch((e: unknown) => {
    throw new Error(explainConnectError(e, host, port));
  });
  try {
    let amneziaReady = await hasAmnezia(ssh);

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

    let installedNow = false;
    if (!amneziaReady) {
      await onProgress?.('🛠 VPN на сервере не найден — ставлю его сам. Это 2–5 минут (на свежем VPS иногда дольше), жди…');
      // SERVER_PUB_IP = адрес, по которому мы этот сервер добавляем: Endpoint в
      // конфигах будет верным сразу, а host локации его же ещё и подстрахует
      // (withEndpointHost). Человеческие ошибки (apt занят, ОС не та) установщик
      // пишет в stderr — они и всплывут через runScriptOn.
      await runScriptOn(ssh, INSTALL_SCRIPT, [host], INSTALL_SCRIPT_TIMEOUT_MS);
      installedNow = true;
      amneziaReady = true;
    }
    return { privateKey: priv, amneziaReady, installedNow };
  } finally {
    ssh.dispose();
  }
}

/** Есть ли на сервере рабочий AmneziaWG (интерфейс поднят и утилита на месте). */
async function hasAmnezia(ssh: NodeSSH): Promise<boolean> {
  const check = await ssh.execCommand(
    'test -f /etc/amnezia/amneziawg/awg0.conf && command -v awg >/dev/null 2>&1 && echo OK || echo NO',
  );
  return check.stdout.trim().endsWith('OK');
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
  try {
    return await runScriptOn(ssh, localScriptPath, args, timeoutMs);
  } finally {
    ssh.dispose();
  }
}

/**
 * Заливает и выполняет скрипт на УЖЕ ОТКРЫТОМ соединении (соединение не
 * закрывает — им владеет вызывающий). Нужно, чтобы attachServer мог поставить
 * VPN по тому же паролю, по которому только что зашёл, не переподключаясь.
 */
async function runScriptOn(
  ssh: NodeSSH,
  localScriptPath: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
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
