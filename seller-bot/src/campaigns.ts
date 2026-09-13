import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hasUsedTrial } from './trials.js';
import { hasPurchased } from './stats.js';

// Метки на ссылке (`?start=luna-trial`) — не реферальный код (тот числовой, `rNNN`,
// см. referrals.ts), а произвольная бирка партнёра/канала: «сколько перешло по ЭТОЙ
// ссылке, сколько из них взяли пробник, сколько купили» (просьба 13.09 через kodeX —
// у него внешнее приложение «Луна Коннект» встраивает бота как плагин с такой ссылкой).
//
// Считаем ПЕРВЫЙ вход по каждой метке на человека — иначе «сколько перешло»
// раздувалось бы каждым повторным /start по той же ссылке.

const FILE = path.join(config.dataDir, 'campaigns.json');

interface Touch {
  tag: string;
  userId: number;
  ts: number;
}

function read(): Touch[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as Touch[]) : [];
  } catch {
    return [];
  }
}

function write(rows: Touch[]): void {
  try {
    writeFileSync(FILE, JSON.stringify(rows));
  } catch {
    /* телеметрия не должна ронять бота */
  }
}

// Метка — то же, что допускает Telegram в start-параметре (буквы/цифры/-/_), и не
// цифровой реферальный код (см. referrals.ts::parseCode — тот строго `r<цифры>`).
const TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isCampaignTag(payload: string | undefined): payload is string {
  if (!payload) return false;
  const p = payload.trim();
  return TAG_RE.test(p) && !/^r\d+$/.test(p);
}

/** Первый заход по метке — записывает; повторный — не трогает файл. */
export function recordCampaignTouch(tag: string, userId: number): void {
  const rows = read();
  if (rows.some((r) => r.tag === tag && r.userId === userId)) return;
  rows.push({ tag, userId, ts: Date.now() });
  write(rows);
}

export interface CampaignReport {
  tag: string;
  starts: number;
  trials: number;
  purchases: number;
}

/** Сколько перешло по метке, сколько из них взяли пробник, сколько купили. */
export function campaignReport(tag: string): CampaignReport {
  const users = [...new Set(read().filter((r) => r.tag === tag).map((r) => r.userId))];
  let trials = 0;
  let purchases = 0;
  for (const u of users) {
    if (hasUsedTrial(u)) trials++;
    if (hasPurchased(u)) purchases++;
  }
  return { tag, starts: users.length, trials, purchases };
}

/** Все метки, по которым хоть раз переходили — для /campaigns без аргумента. */
export function allCampaignTags(): string[] {
  return [...new Set(read().map((r) => r.tag))];
}
