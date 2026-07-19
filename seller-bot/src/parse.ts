import { CONFIG_MARKERS } from './constants.js';

const CONFIG_RE = new RegExp(`${CONFIG_MARKERS.START}\\s*([\\s\\S]*?)\\s*${CONFIG_MARKERS.END}`);

// Достаёт клиентский VPN-конфиг из вывода add-peer скрипта (между маркерами).
export function extractClientConfig(stdout: string): string | null {
  const m = stdout.match(CONFIG_RE);
  return m ? m[1].trim() : null;
}
