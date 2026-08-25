import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { PRIMARY_LOCATION_ID } from './locations.js';

// Конфиг владельца храним один раз НА ЛОКАЦИЮ и переиспользуем — чтобы не
// плодить пиры на каждый клик. До 26.08 файл хранил ОДИН конфиг вообще
// (без привязки к локации), а генерация всегда шла только на primary
// (createVpnPeer() без аргумента) — владелец физически не мог получить
// через «Мой VPN» ничего, кроме основного сервера, даже когда у него уже
// были рабочие доп. локации. Формат сменён на JSON-карту locId → конфиг.
const OLD_FILE = path.join(config.dataDir, 'owner.conf');
const FILE = path.join(config.dataDir, 'owner-configs.json');

type OwnerConfigs = Record<string, string>;

function load(): OwnerConfigs {
  if (existsSync(FILE)) {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as OwnerConfigs;
    } catch {
      /* битый файл — начинаем с чистого */
    }
    return {};
  }
  // Миграция со старого формата: единственный прошлый конфиг был всегда
  // с primary (см. комментарий выше) — переносим его под правильный id.
  if (existsSync(OLD_FILE)) {
    try {
      const legacy = readFileSync(OLD_FILE, 'utf8');
      if (legacy.trim()) return { [PRIMARY_LOCATION_ID]: legacy };
    } catch {
      /* не критично */
    }
  }
  return {};
}

function save(all: OwnerConfigs): void {
  try {
    writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    /* не критично */
  }
}

export function readOwnerConfig(locId: string): string | null {
  return load()[locId] ?? null;
}

export function saveOwnerConfig(locId: string, cfg: string): void {
  const all = load();
  all[locId] = cfg;
  save(all);
}
