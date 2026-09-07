import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSSH } from 'node-ssh';
import { REMOTE, SSH } from './constants.js';
import type { NodeProtocol } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELLER_LOCAL = path.resolve(__dirname, '../../seller-bot');

export interface DeployOpts {
  host: string;
  password: string;
  sellerToken: string;
  ownerId: number;
  stanokUrl: string;
  priceStars: number;
  /** Какой протокол установлен на ЭТОМ (primary) сервере — seller-bot читает его
   *  из .env, чтобы знать, каким add/revoke-скриптом обслуживать локацию 'local'
   *  (см. seller-bot/src/config.ts::primaryProtocol, locations.ts::allLocations). */
  protocol: NodeProtocol;
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

    // 1. Node.js 22 (если нет). Проверяем node И npm: на урезанных образах провайдеров
    // встречается голый node без npm — тогда шаг с pm2 падал на `npm: command not found` (узел #14).
    const hasNode = (await ssh.execCommand('command -v node || true')).stdout.trim();
    const hasNpm = (await ssh.execCommand('command -v npm || true')).stdout.trim();
    if (!hasNode || !hasNpm) {
      const r = await ssh.execCommand(
        `curl -fsSL ${REMOTE.NODE_SETUP_URL} | bash - && apt-get install -y nodejs`,
      );
      if (r.code !== 0) throw new Error('Node.js не установился: ' + (r.stderr || r.stdout).slice(0, 300));
      if (!(await ssh.execCommand('command -v npm || true')).stdout.trim()) {
        throw new Error('на сервере есть node, но нет npm — образ провайдера нестандартный');
      }
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
      `PRIMARY_PROTOCOL=${opts.protocol}`,
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

// Меняет токен у УЖЕ развёрнутого бота-продавца и перезапускает его: не полный передеплой
// (код и data-папка на месте), только строка SELLER_BOT_TOKEN в .env.
//
// 🔴 07.09: заведено после инцидента с отозванным токеном (см. bot-token.ts) — раньше
// единственным способом сменить токен был полный передеплой через онбординг, а он ещё и
// переиспользовал СТАРЫЙ токен, то есть починить это владелец не мог никак.
//
// `pm2 restart --update-env` обязателен: без --update-env pm2 поднимет процесс со старым
// окружением, и новый токен просто не подхватится (эту грабли в проекте уже ловили).
export async function updateSellerToken(host: string, password: string, token: string): Promise<void> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host,
    username: SSH.USERNAME,
    password,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true,
  });
  try {
    const envPath = `${REMOTE.SELLER_DIR}/.env`;
    // 🔴 07.09, живой провал прямо в тот же вечер: сначала токен передавался через
    // `execOptions.env` — чтобы не светился в `ps` на чужом сервере. Но sshd по умолчанию
    // принимает только LANG/LC_* (`AcceptEnv`), так что переменная до сервера не доезжала
    // и в .env писалась ПУСТАЯ строка. Бот оставался сломанным, а станок рапортовал «готово»,
    // потому что сам shell отработал с кодом 0.
    // Теперь: секрет идёт через stdin (в `ps` его так же не видно, но это не зависит от
    // настроек sshd), и главное — результат ПРОВЕРЯЕТСЯ, а не предполагается.
    const script = [
      'read -r NEW_TOKEN',
      '[ -n "$NEW_TOKEN" ] || { echo "ERR: токен не дошёл до сервера"; exit 1; }',
      `grep -v '^SELLER_BOT_TOKEN=' ${envPath} > ${envPath}.tmp`,
      `printf 'SELLER_BOT_TOKEN=%s\\n' "$NEW_TOKEN" >> ${envPath}.tmp`,
      `mv ${envPath}.tmp ${envPath}`,
      `chmod 600 ${envPath}`,
      // Проверка №1: строка реально записалась и не пустая.
      `LEN=$(awk -F= '/^SELLER_BOT_TOKEN=/{print length($2)}' ${envPath})`,
      '[ "${LEN:-0}" -gt 20 ] || { echo "ERR: токен записался пустым (длина ${LEN:-0})"; exit 1; }',
      `cd ${REMOTE.SELLER_DIR}`,
      // Процесс мог быть остановлен (мы сами гасим его при мёртвом токене) — restart поднимет.
      'pm2 restart seller-bot --update-env >/dev/null 2>&1 || pm2 start npm --name seller-bot -- start >/dev/null 2>&1',
      // Проверка №2: бот реально ЖИВЁТ, а не крутится в цикле падений. Смотрим счётчик
      // перезапусков дважды с паузой: если он растёт — процесс падает и поднимается заново.
      'STAT() { pm2 jlist 2>/dev/null | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).find(x=>x.name==="seller-bot");process.stdout.write(a?a.pm2_env.status+" "+a.pm2_env.restart_time:"none 0")}catch(e){process.stdout.write("none 0")}})\'; }',
      'sleep 8',
      'A=$(STAT)',
      'sleep 7',
      'B=$(STAT)',
      'echo "CHECK before=[$A] after=[$B]"',
    ].join('; ');

    const res = await ssh.execCommand(script, { stdin: token + '\n' });
    const out = `${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || out.includes('ERR:')) {
      throw new Error('не удалось применить новый токен: ' + out.replace(/\s+/g, ' ').slice(0, 300));
    }

    // Разбираем итог проверки №2: "CHECK before=[online 5] after=[online 5]"
    const m = out.match(/CHECK before=\[(\w+) (\d+)\] after=\[(\w+) (\d+)\]/);
    if (!m) throw new Error('не удалось проверить, поднялся ли бот: ' + out.replace(/\s+/g, ' ').slice(0, 200));
    const [, , restartsBefore, statusAfter, restartsAfter] = m;
    if (statusAfter !== 'online') {
      throw new Error(`бот не запустился (статус «${statusAfter}») — токен записан, но процесс не поднялся`);
    }
    if (Number(restartsAfter) > Number(restartsBefore)) {
      throw new Error(
        'бот падает и перезапускается по кругу даже с новым токеном — дело не в токене, ' +
          'нужен разбор логов на сервере',
      );
    }
  } finally {
    ssh.dispose();
  }
}

/** Гасит бота-продавца на узле. Нужно, когда он всё равно не может работать (мёртвый токен) —
 *  иначе pm2 будет вечно поднимать падающий процесс и жечь CPU на сервере владельца. */
export async function stopSellerBot(host: string, password: string): Promise<void> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host,
    username: SSH.USERNAME,
    password,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true,
  });
  try {
    await ssh.execCommand('pm2 stop seller-bot');
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
