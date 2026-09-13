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
  /** Купленный срок — тарифные дни, кратные суткам, ИЛИ часы для коротких/пробных.
   *  Только один из двух: не путать «7 дн.» с «7 ч.» задним числом. */
  days?: number;
  hours?: number;
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

const stars = (list: Ev[]) => list.reduce((s, e) => s + (e.stars ?? 0), 0);

/** Есть ли у этого userId хоть одна успешная покупка когда-либо (лог не чистится). */
export function hasPurchased(userId: number): boolean {
  return readEvents().some((e) => e.type === 'paid' && e.userId === userId);
}

/** Продано по срокам ЗА ВСЁ ВРЕМЯ — в отличие от subscriptions.ts::clientsByTerm (только
 *  действующие сейчас), этот лог никогда не чистится, значит переживает истечение клиента.
 *  Старые записи (до 13.09) срока не знают — уходят в «без срока», не теряются молча. */
export function allTimeByTerm(): { term: string; count: number; stars: number }[] {
  const groups = new Map<string, { count: number; stars: number }>();
  for (const e of readEvents().filter((e) => e.type === 'paid')) {
    const term = e.days ? `${e.days} дн.` : e.hours ? `${e.hours} ч.` : 'без срока (запись до 13.09)';
    const g = groups.get(term) ?? { count: 0, stars: 0 };
    g.count++;
    g.stars += e.stars ?? 0;
    groups.set(term, g);
  }
  const rank = (t: string) => (t.endsWith('дн.') ? Number.parseInt(t) * 24 : t.endsWith('ч.') ? Number.parseInt(t) : -1);
  return [...groups.entries()].map(([term, g]) => ({ term, ...g })).sort((a, b) => rank(b.term) - rank(a.term));
}

// Окна для «Аналитика за месяц/2 недели/неделю/3 дня/день» (его прямой запрос 13.09,
// через kodeX). День считаем календарным «месяцем», не 30 днями — понятнее владельцу,
// остальные — скользящим окном от текущего момента.
const WINDOWS: { label: string; days: number | 'month' }[] = [
  { label: 'За месяц', days: 'month' },
  { label: 'За 2 недели', days: 14 },
  { label: 'За неделю', days: 7 },
  { label: 'За 3 дня', days: 3 },
  { label: 'За день', days: 1 },
];

function windowStart(now: Date, days: number | 'month'): number {
  if (days === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return now.getTime() - days * 86_400_000;
}

export async function buildStats(): Promise<string> {
  const evs = readEvents();
  const paid = evs.filter((e) => e.type === 'paid');
  const free = evs.filter((e) => e.type === 'free').length;
  const now = new Date();

  const periodLines = WINDOWS.map(({ label, days }) => {
    const from = windowStart(now, days);
    const list = paid.filter((e) => e.ts >= from);
    return `  ${label}: ${list.length} (${stars(list)} ⭐)`;
  });

  const { total, online } = await livePeers();
  const byTerm = allTimeByTerm();
  const termLines = byTerm.map((t) => `  ${t.term} — ${t.count} (${t.stars} ⭐)`);

  return [
    '📊 Статистика',
    '',
    'Продажи по периодам:',
    ...periodLines,
    '',
    `💰 Покупок всего: ${paid.length} (${stars(paid)} ⭐)`,
    ...(termLines.length ? ['', 'Продано по срокам (за всё время):', ...termLines] : []),
    `🆓 Выдано бесплатно: ${free}`,
    `💳 Активных подписок: ${activeCount()}`,
    `🔑 Всего конфигов на сервере: ${total}`,
    `🟢 Онлайн сейчас: ${online}`,
  ].join('\n');
}
