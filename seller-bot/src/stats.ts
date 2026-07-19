import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AWG } from './constants.js';
import { config } from './config.js';
import { activeCount } from './subscriptions.js';

const execFileP = promisify(execFile);
const FILE = path.join(config.dataDir, 'stats.jsonl');

interface Ev {
  type: 'paid' | 'free';
  stars?: number;
  ts: number;
  userId: number;
}

export function recordEvent(e: Omit<Ev, 'ts'>): void {
  try {
    appendFileSync(FILE, JSON.stringify({ ...e, ts: Date.now() }) + '\n');
  } catch {
    /* не критично */
  }
}

function readEvents(): Ev[] {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Ev;
      } catch {
        return null;
      }
    })
    .filter((e): e is Ev => e !== null);
}

// Живые пиры из awg: всего и «онлайн» (рукопожатие свежее 3 минут).
async function livePeers(): Promise<{ total: number; online: number }> {
  try {
    const { stdout } = await execFileP('awg', ['show', AWG.INTERFACE, 'latest-handshakes'], { timeout: 10_000 });
    const lines = stdout.split('\n').filter((l) => l.trim());
    const now = Math.floor(Date.now() / 1000);
    let online = 0;
    for (const l of lines) {
      const ts = Number(l.trim().split(/\s+/)[1]);
      if (ts && now - ts < AWG.HANDSHAKE_ONLINE_SEC) online++;
    }
    return { total: lines.length, online };
  } catch {
    return { total: 0, online: 0 };
  }
}

export async function buildStats(): Promise<string> {
  const evs = readEvents();
  const paid = evs.filter((e) => e.type === 'paid');
  const free = evs.filter((e) => e.type === 'free').length;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const paidMonth = paid.filter((e) => e.ts >= monthStart);

  const stars = (list: Ev[]) => list.reduce((s, e) => s + (e.stars ?? 0), 0);
  const { total, online } = await livePeers();

  return [
    '📊 Статистика',
    '',
    `🛒 Покупок за месяц: ${paidMonth.length} (${stars(paidMonth)} ⭐)`,
    `💰 Покупок всего: ${paid.length} (${stars(paid)} ⭐)`,
    `🆓 Выдано бесплатно: ${free}`,
    `💳 Активных подписок: ${activeCount()}`,
    `🔑 Всего конфигов на сервере: ${total}`,
    `🟢 Онлайн сейчас: ${online}`,
  ].join('\n');
}
