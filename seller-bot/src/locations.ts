import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type VpnProtocol = 'amneziawg' | 'vless_reality';

// Локации = VPN-серверы, с которых бот выдаёт ключи.
//
// Зачем: до 24.08 бот умел ровно один сервер — тот, на котором сам работает,
// и дёргал скрипт выдачи локально. Клиент-франчайзи попросил «покупает на
// месяц, а ему доступен Лондон и Финляндия»: легли сервера в одной стране —
// человек переключается на другую. Внутри одного конфига AmneziaWG так не
// умеет (Endpoint и ключ прибиты к конкретному серверу), поэтому выдаём
// НЕСКОЛЬКО конфигов — по одному на страну.
//
// Основная локация не хранится в файле и не удаляется: это сервер, где живёт
// сам бот, он есть всегда по определению.

export const PRIMARY_LOCATION_ID = 'local';

const FILE = path.join(config.dataDir, 'locations.json');

export interface RemoteLocation {
  id: string;
  title: string;
  host: string;
  /** SSH-порт. Не хранится, если стандартный 22 — старые записи его и не имеют. */
  port?: number;
  user: string;
  /** Имя файла с приватным ключом внутри dataDir (сам ключ рядом, права 600). */
  keyFile: string;
  addedAt: number;
  /** Какой протокол там установлен. Отсутствует у старых записей — считаем amneziawg
   *  (все локации до 05.09 были только AmneziaWG, миграция задним числом не нужна). */
  protocol?: VpnProtocol;
}

export interface Location {
  id: string;
  title: string;
  /** local — сервер самого бота, ssh — удалённый. */
  kind: 'local' | 'ssh';
  remote?: RemoteLocation;
  protocol: VpnProtocol;
}

export const LOCATION_LIMITS = {
  // Практически «сколько угодно» для одного продавца — было 5, потом 50, подняли
  // до 100 по просьбе (25.08, «хоть 100 VPS»). Не бесконечность: верхняя граница
  // нужна генератору id ниже (nextLocationId перебирает l2..lN) и как защита от
  // случайного спама.
  MAX_REMOTE: 100,
  MAX_TITLE_LEN: 24,
} as const;

function readRemotes(): RemoteLocation[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is RemoteLocation => !!r && typeof r === 'object')
      .filter((r) => typeof r.id === 'string' && typeof r.host === 'string' && typeof r.keyFile === 'string')
      .map((r) => ({
        id: r.id,
        title: String(r.title ?? r.host).slice(0, LOCATION_LIMITS.MAX_TITLE_LEN),
        host: r.host,
        ...(Number.isInteger(r.port) && Number(r.port) > 0 ? { port: Number(r.port) } : {}),
        user: String(r.user ?? 'root'),
        keyFile: r.keyFile,
        addedAt: Number(r.addedAt) || Date.now(),
        ...(r.protocol === 'vless_reality' ? { protocol: 'vless_reality' as const } : {}),
      }));
  } catch {
    return [];
  }
}

function writeRemotes(list: RemoteLocation[]): void {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

/** Название основной локации владелец может поменять — хранится там же, отдельной записью. */
const PRIMARY_TITLE_FILE = path.join(config.dataDir, 'primary-location.txt');

export function primaryTitle(): string {
  try {
    if (existsSync(PRIMARY_TITLE_FILE)) {
      const t = readFileSync(PRIMARY_TITLE_FILE, 'utf8').trim();
      if (t) return t.slice(0, LOCATION_LIMITS.MAX_TITLE_LEN);
    }
  } catch {
    /* нет файла — стандартное имя */
  }
  return 'Основной';
}

export function setPrimaryTitle(title: string): void {
  try {
    writeFileSync(PRIMARY_TITLE_FILE, title.slice(0, LOCATION_LIMITS.MAX_TITLE_LEN));
  } catch {
    /* не критично */
  }
}

/** Все локации: основная всегда первая, дальше добавленные в порядке добавления. */
export function allLocations(): Location[] {
  return [
    { id: PRIMARY_LOCATION_ID, title: primaryTitle(), kind: 'local', protocol: config.primaryProtocol },
    ...readRemotes().map(
      (r): Location => ({ id: r.id, title: r.title, kind: 'ssh', remote: r, protocol: r.protocol ?? 'amneziawg' }),
    ),
  ];
}

export function findLocation(id: string): Location | undefined {
  return allLocations().find((l) => l.id === id);
}

export function remoteCount(): number {
  return readRemotes().length;
}

export function nextLocationId(): string {
  const used = new Set(readRemotes().map((r) => r.id));
  for (let i = 2; i <= LOCATION_LIMITS.MAX_REMOTE + 2; i++) {
    if (!used.has(`l${i}`)) return `l${i}`;
  }
  return `l${Date.now()}`;
}

export function keyPath(keyFile: string): string {
  return path.join(config.dataDir, keyFile);
}

/**
 * Сохраняет приватный ключ доступа к серверу.
 *
 * 🔑 Почему ключ, а не root-пароль: пароль вводится владельцем ОДИН раз —
 * им бот заходит, ставит себе собственный ключ в authorized_keys и пароль
 * забывает, на диск он не попадает вообще. Так утечка data-папки не отдаёт
 * root-пароль от чужого сервера, и владелец может сменить пароль, ничего
 * не сломав. Права 600 — файл читает только root, под которым и работает бот.
 */
export function saveKey(keyFile: string, privateKey: string): void {
  const p = keyPath(keyFile);
  writeFileSync(p, privateKey, { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // на случай, если umask вмешался при создании
  } catch {
    /* не все ФС поддерживают — не критично */
  }
}

export function readKey(keyFile: string): string {
  return readFileSync(keyPath(keyFile), 'utf8');
}

export function addRemote(loc: Omit<RemoteLocation, 'addedAt'>): RemoteLocation {
  // protocol отсутствует у вызывающего кода до 05.09 (cli-add-location.ts старой
  // версии) — undefined тут и означает amneziawg, ничего особого делать не нужно,
  // readRemotes()/allLocations() уже трактуют отсутствие поля так же.
  const list = readRemotes();
  const row: RemoteLocation = { ...loc, addedAt: Date.now() };
  list.push(row);
  writeRemotes(list);
  return row;
}

/**
 * Убирает локацию из списка. Ключ доступа тоже удаляем — он больше ни для
 * чего не нужен, а лежать секрету просто так незачем.
 *
 * ⚠️ Выданные на этом сервере пиры НЕ отзываются: сервер могли отключить
 * или он мог уже лежать, и попытка сходить туда по SSH подвесила бы удаление.
 * Клиенты просто перестанут им пользоваться, а сам сервер владелец всё равно
 * гасит целиком.
 */
export function removeRemote(id: string): boolean {
  const list = readRemotes();
  const row = list.find((r) => r.id === id);
  if (!row) return false;
  writeRemotes(list.filter((r) => r.id !== id));
  try {
    unlinkSync(keyPath(row.keyFile));
  } catch {
    /* ключа уже нет — не страшно */
  }
  return true;
}

/**
 * Меняет адрес (IP/host, при необходимости SSH-порт) существующей локации,
 * сохраняя ключ доступа и название. Нужно, когда у сервера сменился IP — у этих
 * VPS это обычное дело: раньше приходилось удалять и заводить заново. Ключ на
 * сервере (та же машина, новый IP) переживает смену адреса, поэтому доступ
 * сохраняется. Порт убираем, если снова стандартный 22.
 */
export function updateRemoteHost(id: string, host: string, port?: number): boolean {
  const list = readRemotes();
  const row = list.find((r) => r.id === id);
  if (!row) return false;
  row.host = host;
  if (port && port !== 22) row.port = port;
  else delete row.port;
  writeRemotes(list);
  return true;
}

export function renameLocation(id: string, title: string): void {
  const clean = title.trim().slice(0, LOCATION_LIMITS.MAX_TITLE_LEN);
  if (!clean) return;
  if (id === PRIMARY_LOCATION_ID) {
    setPrimaryTitle(clean);
    return;
  }
  const list = readRemotes();
  const row = list.find((r) => r.id === id);
  if (!row) return;
  row.title = clean;
  writeRemotes(list);
}

/**
 * Разбирает «адрес» так, как его пишет человек: `1.2.3.4`, `1.2.3.4:2222`,
 * `vpn.example.com:22`.
 *
 * Зачем вообще порт (23.08): у первого же клиента SSH оказался НЕ на 22 —
 * бот упирался в «Timed out while waiting for handshake» и добавить сервер
 * было физически нельзя. Провайдеры (и сами владельцы, ради защиты от
 * брутфорса) часто уводят SSH на другой порт — это норма, а не экзотика.
 */
export function parseHostPort(s: string): { host: string; port?: number } | null {
  const v = s.trim();
  const m = v.match(/^(.+?):(\d{1,5})$/);
  if (!m) return isValidHost(v) ? { host: v } : null;
  const host = m[1];
  const port = Number(m[2]);
  if (!isValidHost(host) || port < 1 || port > 65535) return null;
  // 22 не храним: пусть запись выглядит так же, как у всех остальных.
  return port === 22 ? { host } : { host, port };
}

/** Простая проверка IPv4/hostname — чтобы не гонять SSH на явную опечатку. */
export function isValidHost(s: string): boolean {
  const v = s.trim();
  if (v.length === 0 || v.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(v);
}
