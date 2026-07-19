import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Цену за подписку владелец задаёт сам в боте; храним в data-папке (переживает обновления).
const FILE = path.join(config.dataDir, 'price.txt');
const MAX_STARS = 100_000;

let price = load();

function load(): number {
  if (existsSync(FILE)) {
    const n = Number(readFileSync(FILE, 'utf8').trim());
    if (isValidPrice(n)) return n;
  }
  return config.priceStars; // дефолт (проставляет станок при деплое)
}

export function isValidPrice(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_STARS;
}

export function getPrice(): number {
  return price;
}

export function setPrice(stars: number): boolean {
  if (!isValidPrice(stars)) return false;
  price = stars;
  try {
    writeFileSync(FILE, String(stars));
  } catch {
    /* не критично */
  }
  return true;
}
