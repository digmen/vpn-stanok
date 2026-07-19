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
