import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSSH } from 'node-ssh';
import { REMOTE, SSH } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELLER_LOCAL = path.resolve(__dirname, '../../seller-bot');

export interface DeployOpts {
  host: string;
  password: string;
  sellerToken: string;
  ownerId: number;
  stanokUrl: string;
  priceStars: number;
}

// Разворачивает бота-продавца на сервере узла: Node + pm2 + код + npm install + .env + запуск.
export async function deploySeller(opts: DeployOpts): Promise<void> {
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
    const remoteDir = REMOTE.SELLER_DIR;

    // 1. Node.js 22 (если нет)
    if (!(await ssh.execCommand('command -v node || true')).stdout.trim()) {
      const r = await ssh.execCommand(
        `curl -fsSL ${REMOTE.NODE_SETUP_URL} | bash - && apt-get install -y nodejs`,
      );
      if (r.code !== 0) throw new Error('Node.js не установился: ' + (r.stderr || r.stdout).slice(0, 300));
    }

    // 2. pm2 (если нет)
    if (!(await ssh.execCommand('command -v pm2 || true')).stdout.trim()) {
      const r = await ssh.execCommand('npm install -g pm2');
      if (r.code !== 0) throw new Error('pm2 не установился: ' + (r.stderr || r.stdout).slice(0, 300));
    }

    // 3. Заливаем код заново (data-папка сохраняется — там цена, статистика, конфиг владельца)
    await ssh.execCommand(`rm -rf ${remoteDir} && mkdir -p ${remoteDir} ${REMOTE.SELLER_DATA_DIR}`);
    const uploaded = await ssh.putDirectory(SELLER_LOCAL, remoteDir, {
      recursive: true,
      concurrency: 5,
      validate: (p) => {
        const b = path.basename(p);
        return b !== 'node_modules' && b !== '.env' && b !== 'dist' && b !== '.git' && b !== '.owner';
      },
    });
    if (!uploaded) throw new Error('не удалось залить код бота-продавца');

    // 4. Зависимости
    const inst = await ssh.execCommand('npm install --no-audit --no-fund', { cwd: remoteDir });
    if (inst.code !== 0) throw new Error('npm install упал: ' + (inst.stderr || inst.stdout).slice(0, 300));

    // 5. .env (через heredoc, чтобы токен не светился в списке процессов)
    const env = [
      `SELLER_BOT_TOKEN=${opts.sellerToken}`,
      `OWNER_ID=${opts.ownerId}`,
      `STANOK_URL=${opts.stanokUrl}`,
      `PRICE_STARS=${opts.priceStars}`,
      `DATA_DIR=${REMOTE.SELLER_DATA_DIR}`,
    ].join('\n');
    const writeEnv = await ssh.execCommand(`cat > ${remoteDir}/.env <<'ENVEOF'\n${env}\nENVEOF`);
    if (writeEnv.code !== 0) throw new Error('не удалось записать .env');

    // 6. Запуск под pm2
    const start = await ssh.execCommand(
      'pm2 delete seller-bot 2>/dev/null; pm2 start npm --name seller-bot -- start && pm2 save',
      { cwd: remoteDir },
    );
    if (start.code !== 0) throw new Error('pm2 не запустил бота: ' + (start.stderr || start.stdout).slice(0, 300));
  } finally {
    ssh.dispose();
  }
}

// Спрашивает у Telegram username бота по токену — чтобы дать узлу ссылку на его бота.
export async function getBotUsername(token: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await r.json()) as { ok: boolean; result?: { username?: string } };
    return j.ok && j.result?.username ? j.result.username : null;
  } catch {
    return null;
  }
}
