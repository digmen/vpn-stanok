import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Кому уже выдавали пробный период. Один человек — один раз, иначе бесплатный VPN
// раздаётся бесконечно нажатием одной кнопки.
const FILE = path.join(config.dataDir, 'trials.json');

function read(): number[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as number[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function hasUsedTrial(userId: number): boolean {
  return read().includes(userId);
}

export function markTrialUsed(userId: number): void {
  const ids = read();
  if (ids.includes(userId)) return;
  ids.push(userId);
  try {
    writeFileSync(FILE, JSON.stringify(ids));
  } catch {
    /* не критично */
  }
}

export function trialCount(): number {
  return read().length;
}
