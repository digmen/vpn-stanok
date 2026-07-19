import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Конфиг владельца храним один раз и переиспользуем — чтобы не плодить пиры на каждый клик.
const FILE = 'owner.conf';

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
