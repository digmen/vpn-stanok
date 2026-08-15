import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Всё, что владелец узла настраивает под себя: тарифы, пробный период, приветствие.
// Живёт в data-папке — переживает обновление кода.
//
// Почему настройки здесь, а не в станке: иначе каждая правка цены = SSH-заход на его сервер,
// а станок становится точкой отказа. Станок раздаёт код, узел владеет настройками.

const FILE = path.join(config.dataDir, 'settings.json');
const LEGACY_PRICE = path.join(config.dataDir, 'price.txt');

export interface Package {
  id: string;
  days: number;
  stars: number;
}

export interface Settings {
  packages: Package[];
  trial: { enabled: boolean; days: number };
  welcome: { text: string | null; photo: string | null };
}

export const LIMITS = {
  MAX_PACKAGES: 6,
  MAX_STARS: 100_000,
  MAX_DAYS: 3650,
  MAX_WELCOME_LEN: 800,
} as const;

export function isValidStars(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= LIMITS.MAX_STARS;
}

export function isValidDays(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= LIMITS.MAX_DAYS;
}

// Стартовый набор тарифов. Базовая цена — то, что владелец уже поставил в старой версии
// (price.txt): его настройку нельзя терять при обновлении, иначе он молча начнёт продавать дешевле.
export function defaultPackages(baseStars: number, baseDays: number): Package[] {
  return [
    { id: 'p1', days: baseDays, stars: baseStars },
    { id: 'p2', days: baseDays * 2, stars: Math.ceil(baseStars * 1.8) },
    { id: 'p3', days: baseDays * 3, stars: Math.ceil(baseStars * 2.5) },
  ];
}

function legacyPrice(): number {
  try {
    if (existsSync(LEGACY_PRICE)) {
      const n = Number(readFileSync(LEGACY_PRICE, 'utf8').trim());
      if (isValidStars(n)) return n;
    }
  } catch {
    /* нет старой цены — берём из .env */
  }
  return config.priceStars;
}

function fresh(): Settings {
  return {
    packages: defaultPackages(legacyPrice(), config.days),
    trial: { enabled: false, days: 3 },
    welcome: { text: null, photo: null },
  };
}

// Читаем терпимо: битый или частичный файл не должен ронять бота — добираем дефолтами.
export function normalize(raw: unknown): Settings {
  const base = fresh();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<Settings>;

  const packages = Array.isArray(r.packages)
    ? r.packages
        .filter((p) => p && isValidDays(Number(p.days)) && isValidStars(Number(p.stars)))
        .slice(0, LIMITS.MAX_PACKAGES)
        .map((p, i) => ({ id: String(p.id ?? `p${i + 1}`), days: Number(p.days), stars: Number(p.stars) }))
    : [];

  return {
    packages: packages.length > 0 ? packages : base.packages,
    trial: {
      enabled: Boolean(r.trial?.enabled),
      days: isValidDays(Number(r.trial?.days)) ? Number(r.trial!.days) : base.trial.days,
    },
    welcome: {
      text: typeof r.welcome?.text === 'string' ? r.welcome.text.slice(0, LIMITS.MAX_WELCOME_LEN) : null,
      photo: typeof r.welcome?.photo === 'string' ? r.welcome.photo : null,
    },
  };
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? normalize(JSON.parse(readFileSync(FILE, 'utf8'))) : fresh();
  } catch {
    cache = fresh();
  }
  return cache;
}

export function saveSettings(next: Settings): Settings {
  cache = normalize(next);
  try {
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch {
    /* не критично: настройки останутся в памяти до перезапуска */
  }
  return cache;
}

export function updateSettings(patch: (s: Settings) => Settings): Settings {
  return saveSettings(patch(structuredClone(getSettings())));
}

export function findPackage(id: string): Package | undefined {
  return getSettings().packages.find((p) => p.id === id);
}

export function nextPackageId(): string {
  const used = new Set(getSettings().packages.map((p) => p.id));
  for (let i = 1; i <= LIMITS.MAX_PACKAGES + 1; i++) {
    if (!used.has(`p${i}`)) return `p${i}`;
  }
  return `p${Date.now()}`;
}

// Человекочитаемо: «30 дней — 50 ⭐»
export function packageLabel(p: Package): string {
  const d = p.days;
  const word = d % 10 === 1 && d % 100 !== 11 ? 'день' : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 10 || d % 100 >= 20) ? 'дня' : 'дней';
  return `${d} ${word} — ${p.stars} ⭐`;
}
