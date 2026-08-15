/**
 * Забирает журнал шагов с боевого сервера на ноутбук, чтобы разбирать воронку
 * локально и не терять историю, если сервер однажды не продлят.
 *
 *   npm run pull-events
 *
 * Копит в `data/events.jsonl` (в git не попадает), докачивает только новое —
 * по максимальному id, который уже лежит локально. Секретов там нет по построению:
 * бот пишет в журнал шаг, IP и причину отказа, но не пароли и не токены.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../data/events.jsonl');
const HOST = process.env.STANOK_HOST ?? '2.27.86.8';
const KEY = process.env.STANOK_SSH_KEY ?? path.join(os.homedir(), '.secrets', 'vpn-stanok-deploy');
const REMOTE_DIR = '/root/vpn-franchise/stanok-bot';

function lastLocalId(): number {
  if (!existsSync(OUT)) return 0;
  let max = 0;
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const id = JSON.parse(line).id as number;
    if (id > max) max = id;
  }
  return max;
}

const since = lastLocalId();
// Читаем базу на сервере в режиме только-чтение: бот в это время спокойно работает.
const remote = `cd ${REMOTE_DIR} && node -e '
  const D=require("better-sqlite3");
  const d=new D("stanok.db",{readonly:true});
  for (const r of d.prepare("SELECT * FROM events WHERE id > ? ORDER BY id").all(${since}))
    console.log(JSON.stringify(r));
'`;

const res = spawnSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', `root@${HOST}`, remote], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (res.status !== 0) {
  console.error('❌ не забрал журнал:', (res.stderr || res.stdout || '').trim().slice(0, 400));
  process.exit(1);
}

const lines = res.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
if (lines.length === 0) {
  console.log(`Нового нет (локально уже ${since} событий).`);
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  appendFileSync(OUT, lines.join('\n') + '\n');
  console.log(`✅ добавлено ${lines.length} событий → ${OUT}`);
}
