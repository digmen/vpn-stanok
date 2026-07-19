import { NodeSSH } from 'node-ssh';
import { REMOTE, SSH } from './constants.js';
import { extractClientConfig } from './parse.js';

export interface RemoteInstallOptions {
  host: string;
  password: string;
  scriptLocalPath: string;
  args?: string[];
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Заходит на сервер по SSH, заливает install-скрипт, запускает его с аргументами
// и возвращает клиентский VPN-конфиг (между маркерами в выводе скрипта).
export async function runRemoteInstall(opts: RemoteInstallOptions): Promise<string> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: opts.host,
    username: SSH.USERNAME,
    password: opts.password,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true, // многие серверы принимают пароль только через keyboard-interactive
  });

  try {
    await ssh.putFile(opts.scriptLocalPath, REMOTE.INSTALL_SCRIPT);
    const argStr = (opts.args ?? []).map(shellQuote).join(' ');
    const res = await ssh.execCommand(`bash ${REMOTE.INSTALL_SCRIPT} ${argStr}`);

    if (res.code !== 0) {
      throw new Error(`install-скрипт упал (code ${res.code}): ${res.stderr || res.stdout}`.slice(0, 500));
    }

    const cfg = extractClientConfig(res.stdout);
    if (!cfg) {
      throw new Error('Не нашёл клиентский конфиг в выводе скрипта');
    }
    return cfg;
  } finally {
    ssh.dispose();
  }
}

// Реальная проверка здоровья узла: жив ли процесс бота-продавца И поднят ли VPN-интерфейс.
// Порт 22 сам по себе этого не показывает (сервер жив ≠ сервис жив).
export async function checkNodeAlive(host: string, password: string): Promise<boolean> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host,
      username: SSH.USERNAME,
      password,
      port: SSH.PORT,
      readyTimeout: SSH.READY_TIMEOUT_MS,
      tryKeyboard: true,
    });
    const res = await ssh.execCommand('pm2 pid seller-bot >/dev/null 2>&1 && awg show awg0 >/dev/null 2>&1 && echo OK');
    return res.stdout.trim() === 'OK';
  } catch {
    return false;
  } finally {
    ssh.dispose();
  }
}
