import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Подписки платных клиентов: публичный ключ пира + когда истекает. Живут в data-папке.
const FILE = path.join(config.dataDir, 'subs.json');
const DAY_MS = 86_400_000;

interface Sub {
  pubkey: string;
  expiresAt: number;
}

function read(): Sub[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Sub[];
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

export function addSubscription(pubkey: string, days: number): void {
  const subs = read();
  subs.push({ pubkey, expiresAt: Date.now() + days * DAY_MS });
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
