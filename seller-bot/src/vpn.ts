import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_SCRIPT_TIMEOUT_MS } from './constants.js';
import { extractClientConfig, withEndpointHost, withVlessHost, withVlessHostPort } from './parse.js';
import { allLocations, findLocation, getClientEndpoint, PRIMARY_LOCATION_ID, type Location, type VpnProtocol } from './locations.js';
import { runScript } from './ssh.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Скрипты выдачи/отзыва — пара на протокол. Какую пару взять для конкретной
// локации решает scriptsFor(loc.protocol), а не что-то жёстко зашитое здесь —
// раньше (до 05.09) был всего один протокол, и путь был захардкожен прямо в
// createVpnPeerAt/revokePeerAt; теперь локации бывают разного протокола, и
// каждая помнит свой (см. locations.ts::Location.protocol).
const SCRIPTS: Record<VpnProtocol, { add: string; revoke: string }> = {
  amneziawg: {
    add: path.resolve(__dirname, '../scripts/add-amneziawg-peer.sh'),
    revoke: path.resolve(__dirname, '../scripts/revoke-amneziawg-peer.sh'),
  },
  vless_reality: {
    add: path.resolve(__dirname, '../scripts/add-vless-reality-peer.sh'),
    revoke: path.resolve(__dirname, '../scripts/revoke-vless-reality-peer.sh'),
  },
  vless_ws_tls: {
    add: path.resolve(__dirname, '../scripts/add-vless-ws-tls-peer.sh'),
    revoke: path.resolve(__dirname, '../scripts/revoke-vless-ws-tls-peer.sh'),
  },
};

export interface Peer {
  config: string;
  pubkey: string;
  /** На какой локации выдан — нужно, чтобы потом отозвать именно там. */
  loc: string;
  /** Человеческое название локации для подписи конфига клиенту. */
  locTitle: string;
  /** Протокол этой локации — какое приложение/инструкцию показать (см. delivery.ts). */
  protocol: VpnProtocol;
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
  const scripts = SCRIPTS[loc.protocol];
  try {
    const stdout =
      loc.kind === 'local'
        ? (await execFileP('bash', [scripts.add], { timeout: PEER_SCRIPT_TIMEOUT_MS })).stdout
        : await runScript(loc.remote!, scripts.add, [], PEER_SCRIPT_TIMEOUT_MS);
    const { config, pubkey } = parsePeerOutput(stdout);
    // Endpoint/host берём из АДРЕСА ЛОКАЦИИ в боте, а не из того, что скрипт сам
    // определил на сервере (общий фикс бага 25.08, см. withEndpointHost/
    // withVlessHost) — какую именно функцию звать, решает протокол локации.
    // У основного сервера отдельного адреса в боте нет — оставляем как пришло.
    const host = loc.kind === 'ssh' ? loc.remote?.host : undefined;
    // 🔴 07.09: релей-переадресация (см. locations.ts::getClientEndpoint) стоит
    // ВЫШЕ обычного host-фикса — если для этой локации включён релей, клиент
    // должен получить адрес релея (Прага + свой порт), а не адрес самого узла,
    // даже если тот тоже указан. uuid/pbk/sid клиента не трогаем — они настоящие.
    // 🔴 08.09, живой баг: обе проверки ниже были написаны как `=== 'vless_reality'`, и
    // появление третьего протокола (vless_ws_tls) их молча выключило — клиент получал
    // адрес САМОГО узла вместо релея и не мог подключиться вообще (узел из РФ напрямую
    // недоступен, ради чего релей и заведён). Компилятор такое не ловит: это сравнение
    // значений, а не разбор всех вариантов типа.
    // Правильный признак здесь — «ссылка вида vless://», а не конкретный протокол:
    // подмена host:port одинаково верна для любого из них, а отличается лишь AmneziaWG
    // со своим форматом конфига.
    const isVless = loc.protocol !== 'amneziawg';
    const relay = isVless ? getClientEndpoint(loc.id) : undefined;
    const finalConfig = relay
      ? withVlessHostPort(config, relay.host, relay.port)
      : host
        ? (isVless ? withVlessHost(config, host) : withEndpointHost(config, host))
        : config;
    return { config: finalConfig, pubkey, loc: loc.id, locTitle: loc.title, protocol: loc.protocol };
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

/** Отзывает клиента по публичному ключу (для VLESS — по UUID) на той локации, где он был выдан. */
export async function revokePeerAt(locId: string, pubkey: string): Promise<void> {
  const loc = findLocation(locId);
  if (!loc) {
    // Локацию удалили из списка — отзывать физически негде и незачем:
    // владелец гасит такой сервер целиком (см. removeRemote в locations.ts).
    return;
  }
  const revokeScript = SCRIPTS[loc.protocol].revoke;
  if (loc.kind === 'local') {
    await execFileP('bash', [revokeScript, pubkey], { timeout: 30_000 });
    return;
  }
  await runScript(loc.remote!, revokeScript, [pubkey], 30_000);
}
