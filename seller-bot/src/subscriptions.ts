import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Подписки клиентов: публичный ключ пира, когда истекает и кто купил.
// Живут в data-папке. Записи старого формата (только pubkey + expiresAt) читаются как есть —
// у первых узлов такие уже накопились, терять их нельзя.
const FILE = path.join(config.dataDir, 'subs.json');
const DAY_MS = 86_400_000;

export interface Sub {
  pubkey: string;
  expiresAt: number;
  userId?: number;
  username?: string;
  days?: number;
  stars?: number;
  boughtAt?: number;
}

function read(): Sub[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Sub[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function write(subs: Sub[]): void {
  try {
    writeFileSync(FILE, JSON.stringify(subs));
  } catch {
    /* не критично */
  }
}

export function addSubscription(
  pubkey: string,
  days: number,
  buyer?: { userId?: number; username?: string; stars?: number },
): void {
  const subs = read();
  subs.push({
    pubkey,
    expiresAt: Date.now() + days * DAY_MS,
    days,
    boughtAt: Date.now(),
    ...(buyer?.userId !== undefined ? { userId: buyer.userId } : {}),
    ...(buyer?.username ? { username: buyer.username } : {}),
    ...(buyer?.stars !== undefined ? { stars: buyer.stars } : {}),
  });
  write(subs);
}

// Истёкшие ключи — БЕЗ удаления из хранилища (удаляем только после успешного отзыва).
export function getExpired(now = Date.now()): string[] {
  return read()
    .filter((s) => s.expiresAt <= now)
    .map((s) => s.pubkey);
}

// Убираем подписку из хранилища — вызывать только когда пир реально отозван.
export function removeSubscription(pubkey: string): void {
  const subs = read();
  const next = subs.filter((s) => s.pubkey !== pubkey);
  if (next.length !== subs.length) write(next);
}

export function activeCount(now = Date.now()): number {
  return read().filter((s) => s.expiresAt > now).length;
}

export function allSubs(): Sub[] {
  return read();
}

export interface ClientRow {
  who: string;
  daysLeft: number;
  days?: number;
  stars?: number;
}

// Кто сейчас пользуется и сколько ему осталось — для CRM-экрана владельца.
export function activeClients(now = Date.now()): ClientRow[] {
  return read()
    .filter((s) => s.expiresAt > now)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .map((s) => ({
      who: s.username ? '@' + s.username : s.userId ? String(s.userId) : 'клиент до обновления',
      daysLeft: Math.max(0, Math.ceil((s.expiresAt - now) / DAY_MS)),
      days: s.days,
      stars: s.stars,
    }));
}

export function revenueStars(now = Date.now()): { total: number; active: number } {
  const subs = read();
  return {
    total: subs.reduce((s, x) => s + (x.stars ?? 0), 0),
    active: subs.filter((x) => x.expiresAt > now).reduce((s, x) => s + (x.stars ?? 0), 0),
  };
}
