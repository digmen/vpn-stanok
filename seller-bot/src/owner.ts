import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';

const OWNER_FILE = '.owner';

// Приоритет: OWNER_ID из .env → сохранённый .owner → 0 (ещё не назначен).
let ownerId: number =
  config.ownerId || (existsSync(OWNER_FILE) ? Number(readFileSync(OWNER_FILE, 'utf8').trim()) || 0 : 0);

export function getOwnerId(): number {
  return ownerId;
}

// Если владелец ещё не назначен — назначаем первого, кто нажал /start, и запоминаем.
export function claimOwnerIfUnset(id: number): boolean {
  if (ownerId) return false;
  ownerId = id;
  try {
    writeFileSync(OWNER_FILE, String(id), { mode: 0o600 });
  } catch {
    /* не критично */
  }
  return true;
}
