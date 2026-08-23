import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { PRIMARY_LOCATION_ID } from './locations.js';

// Подписки клиентов: какие пиры выданы, когда истекает и кто купил.
// Живут в data-папке.
//
// 🔴 ТРИ формата в одном файле — читаем все, пишем только новый:
//   v1  { pubkey, expiresAt }                     — самые первые узлы
//   v2  { pubkey, expiresAt, userId, ... }        — добавились данные покупателя
//   v3  { peers: [{loc, pubkey}], expiresAt, ...} — 24.08, несколько локаций
// v1/v2 накопились на живых узлах, и терять их нельзя: там действующие
// оплаченные подписки. Поэтому read() приводит любую запись к v3 в памяти,
// а на диск пишется уже только v3. Файл конвертируется сам при первой записи.
const FILE = path.join(config.dataDir, 'subs.json');
const DAY_MS = 86_400_000;

/** Один выданный ключ: на какой локации он живёт и его публичный ключ. */
export interface SubPeer {
  loc: string;
  pubkey: string;
}

export interface Sub {
  peers: SubPeer[];
  expiresAt: number;
  userId?: number;
  username?: string;
  days?: number;
  stars?: number;
  boughtAt?: number;
}

/** Запись как она могла лежать на диске — любого из трёх поколений. */
interface RawSub {
  pubkey?: string;
  peers?: unknown;
  expiresAt?: unknown;
  userId?: unknown;
  username?: unknown;
  days?: unknown;
  stars?: unknown;
  boughtAt?: unknown;
}

/**
 * Приводит запись любого поколения к текущему виду.
 * Экспортирована ради тестов: это самое опасное место во всём боте —
 * ошибка здесь молча стирает действующие подписки, за которые заплатили.
 */
export function normalizeSub(raw: RawSub): Sub | null {
  if (!raw || typeof raw !== 'object') return null;
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;

  let peers: SubPeer[] = [];
  if (Array.isArray(raw.peers)) {
    peers = raw.peers
      .filter((p): p is { loc?: unknown; pubkey?: unknown } => !!p && typeof p === 'object')
      .map((p) => ({
        // Локация могла не сохраниться — считаем основной: в старом мире
        // сервер был ровно один, и это был он.
        loc: typeof p.loc === 'string' && p.loc ? p.loc : PRIMARY_LOCATION_ID,
        pubkey: String(p.pubkey ?? ''),
      }))
      .filter((p) => p.pubkey !== '');
  } else if (typeof raw.pubkey === 'string' && raw.pubkey) {
    // v1/v2: единственный ключ, всегда на основном сервере
    peers = [{ loc: PRIMARY_LOCATION_ID, pubkey: raw.pubkey }];
  }
  if (peers.length === 0) return null;

  const sub: Sub = { peers, expiresAt };
  if (typeof raw.userId === 'number') sub.userId = raw.userId;
  if (typeof raw.username === 'string') sub.username = raw.username;
  if (typeof raw.days === 'number') sub.days = raw.days;
  if (typeof raw.stars === 'number') sub.stars = raw.stars;
  if (typeof raw.boughtAt === 'number') sub.boughtAt = raw.boughtAt;
  return sub;
}

function read(): Sub[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => normalizeSub(r as RawSub)).filter((s): s is Sub => s !== null);
  } catch {
    return [];
  }
}

function write(subs: Sub[]): void {
  try {
    writeFileSync(FILE, JSON.stringify(subs));
  } catch {
    /* не критично */
  }
}

export function addSubscription(
  peers: SubPeer[],
  days: number,
  buyer?: { userId?: number; username?: string; stars?: number },
): void {
  if (peers.length === 0) return;
  const subs = read();
  subs.push({
    peers,
    expiresAt: Date.now() + days * DAY_MS,
    days,
    boughtAt: Date.now(),
    ...(buyer?.userId !== undefined ? { userId: buyer.userId } : {}),
    ...(buyer?.username ? { username: buyer.username } : {}),
    ...(buyer?.stars !== undefined ? { stars: buyer.stars } : {}),
  });
  write(subs);
}

/**
 * Истёкшие пиры — БЕЗ удаления из хранилища (удаляем только после успешного
 * отзыва). Возвращает плоский список «что и где отзывать»: у одной подписки
 * теперь может быть несколько ключей на разных серверах.
 */
export function getExpiredPeers(now = Date.now()): SubPeer[] {
  return read()
    .filter((s) => s.expiresAt <= now)
    .flatMap((s) => s.peers);
}

/**
 * Убирает один отозванный ключ. Подписка исчезает из файла, только когда
 * отозваны ВСЕ её ключи — иначе оставшиеся на других серверах пиры стали бы
 * сиротами: в файле их нет, а на сервере они продолжают работать бесплатно.
 */
export function removePeer(pubkey: string): void {
  const subs = read();
  let touched = false;
  const next: Sub[] = [];
  for (const s of subs) {
    const keep = s.peers.filter((p) => p.pubkey !== pubkey);
    if (keep.length !== s.peers.length) touched = true;
    if (keep.length > 0) next.push({ ...s, peers: keep });
  }
  if (touched) write(next);
}

export function activeCount(now = Date.now()): number {
  return read().filter((s) => s.expiresAt > now).length;
}

export function allSubs(): Sub[] {
  return read();
}

export interface ClientRow {
  who: string;
  daysLeft: number;
  days?: number;
  stars?: number;
  locations: number;
}

// Кто сейчас пользуется и сколько ему осталось — для CRM-экрана владельца.
export function activeClients(now = Date.now()): ClientRow[] {
  return read()
    .filter((s) => s.expiresAt > now)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .map((s) => ({
      who: s.username ? '@' + s.username : s.userId ? String(s.userId) : 'клиент до обновления',
      daysLeft: Math.max(0, Math.ceil((s.expiresAt - now) / DAY_MS)),
      days: s.days,
      stars: s.stars,
      locations: s.peers.length,
    }));
}

export function revenueStars(now = Date.now()): { total: number; active: number } {
  const subs = read();
  return {
    total: subs.reduce((s, x) => s + (x.stars ?? 0), 0),
    active: subs.filter((x) => x.expiresAt > now).reduce((s, x) => s + (x.stars ?? 0), 0),
  };
}
