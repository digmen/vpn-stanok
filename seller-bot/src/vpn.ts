import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_SCRIPT_TIMEOUT_MS } from './constants.js';
import { extractClientConfig } from './parse.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/add-amneziawg-peer.sh');

// Локально на сервере узла добавляет нового клиента AmneziaWG и возвращает его конфиг.
// При ошибке пробрасываем реальный текст (stderr скрипта), чтобы была видна причина.
export async function createVpnPeer(): Promise<string> {
  try {
    const { stdout } = await execFileP('bash', [SCRIPT], { timeout: PEER_SCRIPT_TIMEOUT_MS });
    const cfg = extractClientConfig(stdout);
    if (!cfg) {
      throw new Error('нет маркеров конфига в выводе: ' + stdout.slice(0, 300));
    }
    return cfg;
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).toString().trim();
    throw new Error(detail.slice(0, 400));
  }
}
