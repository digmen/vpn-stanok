import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Конфиг владельца храним один раз и переиспользуем — чтобы не плодить пиры на каждый клик.
const FILE = path.join(config.dataDir, 'owner.conf');

export function readOwnerConfig(): string | null {
  return existsSync(FILE) ? readFileSync(FILE, 'utf8') : null;
}

export function saveOwnerConfig(cfg: string): void {
  try {
    writeFileSync(FILE, cfg, { mode: 0o600 });
  } catch {
    /* не критично */
  }
}
