import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getClientEndpoint, PRIMARY_LOCATION_ID, type VpnProtocol } from './locations.js';

// Конфиг владельца храним один раз НА ЛОКАЦИЮ и переиспользуем — чтобы не
// плодить пиры на каждый клик. До 26.08 файл хранил ОДИН конфиг вообще
// (без привязки к локации), а генерация всегда шла только на primary
// (createVpnPeer() без аргумента) — владелец физически не мог получить
// через «Мой VPN» ничего, кроме основного сервера, даже когда у него уже
// были рабочие доп. локации. Формат сменён на JSON-карту locId → конфиг.
const OLD_FILE = path.join(config.dataDir, 'owner.conf');
const FILE = path.join(config.dataDir, 'owner-configs.json');

// 🔴 07.09, живой инцидент: узел смигрировали с AmneziaWG на VLESS+Reality (05-06.09),
// а этот кэш никто не тронул — владелец жал «Мой VPN» и получал СТАРЫЙ AmneziaWG-конфиг
// (текст [Interface]/[Peer]), подписанный уже АКТУАЛЬНЫМ протоколом локации (vless_reality) —
// OneXray получал не тот формат вообще. Пойман по жалобе @pisa_roty_shoti (узел #12):
// «взял ключ, не работает». С этого коммита запись хранит ещё и протокол, под которым
// была сгенерирована — если протокол локации сменился, кэш считается устаревшим сам.
//
// 🔴 07.09, тем же вечером: тот же класс бага, второй раз за один заход. Узлу #12
// включили релей (см. relay.ts) уже ПОСЛЕ того, как в кэше лежал рабочий на вид
// vless_reality-конфиг (протокол не менялся, значит по прежней проверке кэш "свежий") —
// а по факту он вёл клиента напрямую на узел, где трафик душится до нуля, мимо релея.
// Теперь запись хранит ещё и адрес релея на момент генерации — несовпадение с текущим
// (релей включили/выключили/сменили порт) тоже считается устаревшим кэшем.
interface OwnerEntry {
  config: string;
  protocol: VpnProtocol;
  /** Адрес релея на момент генерации (`host:port`) или `'-'`, если релея не было. */
  relayKey: string;
}

type OwnerConfigs = Record<string, OwnerEntry | string>;

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
  // Протокол неизвестен (записи ещё старее самого протокола) — читается
  // как amneziawg ниже (isStale не даст соврать, если он уже сменился).
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

/** Записи без protocol (старый формат, строкой) — считаем amneziawg, это был
 *  единственный протокол на момент, когда формат ещё не различал протоколы. */
function protocolOf(entry: OwnerEntry | string): VpnProtocol {
  return typeof entry === 'string' ? 'amneziawg' : entry.protocol;
}

function configOf(entry: OwnerEntry | string): string {
  return typeof entry === 'string' ? entry : entry.config;
}

/** Записи без relayKey (старый формат — до самого релея) — считаем «релея не было»,
 *  тем же значением, что и currentRelayKey() отдаёт при выключенном релее. Так старые
 *  записи не считаются устаревшими зря, если у локации и правда никогда не было релея. */
function relayKeyOf(entry: OwnerEntry | string): string {
  return typeof entry === 'string' ? '-' : entry.relayKey;
}

function currentRelayKey(locId: string): string {
  const r = getClientEndpoint(locId);
  return r ? `${r.host}:${r.port}` : '-';
}

/** null — кэша нет, ИЛИ он от другого протокола (миграция локации), ИЛИ сгенерирован
 *  до/после смены релея (включили, выключили или сменили порт) — в обоих случаях кэш
 *  считается устаревшим, вызывающий код сам перегенерирует актуальным путём. */
export function readOwnerConfig(locId: string, currentProtocol: VpnProtocol): string | null {
  const entry = load()[locId];
  if (!entry) return null;
  if (protocolOf(entry) !== currentProtocol) return null;
  if (relayKeyOf(entry) !== currentRelayKey(locId)) return null;
  return configOf(entry);
}

export function saveOwnerConfig(locId: string, cfg: string, protocol: VpnProtocol): void {
  const all = load();
  all[locId] = { config: cfg, protocol, relayKey: currentRelayKey(locId) };
  save(all);
}
