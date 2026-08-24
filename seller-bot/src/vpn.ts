import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_SCRIPT_TIMEOUT_MS } from './constants.js';
import { extractClientConfig, withEndpointHost } from './parse.js';
import { allLocations, findLocation, PRIMARY_LOCATION_ID, type Location } from './locations.js';
import { runScript } from './ssh.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADD_SCRIPT = path.resolve(__dirname, '../scripts/add-amneziawg-peer.sh');
const REVOKE_SCRIPT = path.resolve(__dirname, '../scripts/revoke-amneziawg-peer.sh');

export interface Peer {
  config: string;
  pubkey: string;
  /** На какой локации выдан — нужно, чтобы потом отозвать именно там. */
  loc: string;
  /** Человеческое название локации для подписи конфига клиенту. */
  locTitle: string;
}

/** Разбор вывода скрипта одинаков и локально, и по SSH — он один и тот же скрипт. */
function parsePeerOutput(stdout: string): { config: string; pubkey: string } {
  const config = extractClientConfig(stdout);
  const pk = stdout.match(/###CLIENT_PUBKEY###(.+)/);
  if (!config || !pk) {
    throw new Error('нет конфига/ключа в выводе: ' + stdout.slice(0, 300));
  }
  return { config, pubkey: pk[1].trim() };
}

function shortError(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  return (err.stderr || err.stdout || err.message || String(e)).toString().trim().slice(0, 400);
}

/** Добавляет клиента на ОДНОЙ конкретной локации. */
export async function createVpnPeerAt(loc: Location): Promise<Peer> {
  try {
    const stdout =
      loc.kind === 'local'
        ? (await execFileP('bash', [ADD_SCRIPT], { timeout: PEER_SCRIPT_TIMEOUT_MS })).stdout
        : await runScript(loc.remote!, ADD_SCRIPT, [], PEER_SCRIPT_TIMEOUT_MS);
    const { config, pubkey } = parsePeerOutput(stdout);
    // Endpoint берём из АДРЕСА ЛОКАЦИИ в боте, а не из зашитого на сервере
    // SERVER_PUB_IP (общий фикс бага 25.08, см. withEndpointHost). У основного
    // сервера отдельного адреса в боте нет — там оставляем как пришло (его IP
    // стабилен, на нём и живёт сам бот).
    const host = loc.kind === 'ssh' ? loc.remote?.host : undefined;
    const finalConfig = host ? withEndpointHost(config, host) : config;
    return { config: finalConfig, pubkey, loc: loc.id, locTitle: loc.title };
  } catch (e: unknown) {
    throw new Error(shortError(e));
  }
}

/** Совместимость со старым вызовом: выдать на основном сервере. */
export async function createVpnPeer(): Promise<Peer> {
  const primary = findLocation(PRIMARY_LOCATION_ID)!;
  return createVpnPeerAt(primary);
}

export interface MultiResult {
  peers: Peer[];
  /** Локации, где выдать не удалось: название → причина. Показываем клиенту. */
  failed: { title: string; reason: string }[];
}

/**
 * Выдаёт клиенту по ключу на КАЖДОЙ локации.
 *
 * Ключевое решение: **частичный успех — это успех.** Человек уже заплатил, и
 * если из трёх стран поднялись две, отдать ему две и извиниться за третью
 * несравнимо лучше, чем уронить всю покупку из-за одного лежащего сервера.
 * Ровно ради таких ситуаций фича и затевалась — «легли сервера в одной стране».
 * Поэтому здесь нет Promise.all: он падает целиком на первой же ошибке.
 */
export async function createVpnPeersEverywhere(): Promise<MultiResult> {
  const peers: Peer[] = [];
  const failed: { title: string; reason: string }[] = [];
  for (const loc of allLocations()) {
    try {
      peers.push(await createVpnPeerAt(loc));
    } catch (e) {
      failed.push({ title: loc.title, reason: shortError(e) });
    }
  }
  return { peers, failed };
}

/** Отзывает клиента по публичному ключу на той локации, где он был выдан. */
export async function revokePeerAt(locId: string, pubkey: string): Promise<void> {
  const loc = findLocation(locId);
  if (!loc) {
    // Локацию удалили из списка — отзывать физически негде и незачем:
    // владелец гасит такой сервер целиком (см. removeRemote в locations.ts).
    return;
  }
  if (loc.kind === 'local') {
    await execFileP('bash', [REVOKE_SCRIPT, pubkey], { timeout: 30_000 });
    return;
  }
  await runScript(loc.remote!, REVOKE_SCRIPT, [pubkey], 30_000);
}
