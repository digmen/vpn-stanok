import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_SCRIPT_TIMEOUT_MS } from './constants.js';
import { extractClientConfig } from './parse.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADD_SCRIPT = path.resolve(__dirname, '../scripts/add-amneziawg-peer.sh');
const REVOKE_SCRIPT = path.resolve(__dirname, '../scripts/revoke-amneziawg-peer.sh');

export interface Peer {
  config: string;
  pubkey: string;
}

// Добавляет клиента AmneziaWG и возвращает его конфиг + публичный ключ (для будущего отзыва).
export async function createVpnPeer(): Promise<Peer> {
  try {
    const { stdout } = await execFileP('bash', [ADD_SCRIPT], { timeout: PEER_SCRIPT_TIMEOUT_MS });
    const config = extractClientConfig(stdout);
    const pk = stdout.match(/###CLIENT_PUBKEY###(.+)/);
    if (!config || !pk) {
      throw new Error('нет конфига/ключа в выводе: ' + stdout.slice(0, 300));
    }
    return { config, pubkey: pk[1].trim() };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).toString().trim();
    throw new Error(detail.slice(0, 400));
  }
}

// Отзывает клиента по публичному ключу (по истечении подписки).
export async function revokePeer(pubkey: string): Promise<void> {
  await execFileP('bash', [REVOKE_SCRIPT, pubkey], { timeout: 30_000 });
}
