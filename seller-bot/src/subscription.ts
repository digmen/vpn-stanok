import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { allSubs, type Sub } from './subscriptions.js';
import { findLocation, getClientEndpoint, type Location } from './locations.js';
import { withVlessHostPort } from './parse.js';
import { runScript } from './ssh.js';
import { PEER_SCRIPT_TIMEOUT_MS } from './constants.js';

// Подписка: один URL на клиента, за которым — все его действующие ключи сразу
// (по одному на локацию). Владелец добавляет/меняет/гасит локации в любой момент —
// клиенту менять ничего не нужно, приложение само перечитывает список по этому же
// адресу (стандартный для VLESS-клиентов формат: GET → base64 текста со ссылками).
//
// 🔴 Не переиспользуем createVpnPeerAt: он каждый раз СОЗДАЁТ нового клиента на
// сервере. Подписку дёргают многократно (клиент обновляет список сам, по расписанию) —
// значит собираем ссылку из УЖЕ выданного pubkey и READ-ONLY чтения параметров узла
// (sub-info-*.sh), ничего не добавляя и не трогая при каждом обращении.

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Пока только vless_ws_tls — это протокол по умолчанию с 08.09, и ровно то, что
// нужно кейсу подписки (WS+TLS отдаёт домен/порт/путь одним файлом на диске узла).
// AmneziaWG и vless_reality в список подписки не попадают — тихо пропускаются.
const INFO_SCRIPT = path.resolve(__dirname, '../scripts/sub-info-vless-ws-tls.sh');

interface ConnInfo {
  domain: string;
  port: number;
  wsPath: string;
}

/** Экспортирована ради тестов — разбор вывода read-only скрипта без реального SSH/exec. */
export function parseConnInfo(stdout: string): ConnInfo | null {
  try {
    const j = JSON.parse(stdout.trim()) as { domain?: unknown; port?: unknown; wsPath?: unknown };
    if (typeof j.domain !== 'string' || !j.domain) return null;
    if (typeof j.port !== 'number') return null;
    if (typeof j.wsPath !== 'string' || !j.wsPath) return null;
    return { domain: j.domain, port: j.port, wsPath: j.wsPath };
  } catch {
    return null;
  }
}

async function readConnInfo(loc: Location): Promise<ConnInfo | null> {
  if (loc.protocol !== 'vless_ws_tls') return null;
  try {
    const stdout =
      loc.kind === 'local'
        ? (await execFileP('bash', [INFO_SCRIPT], { timeout: PEER_SCRIPT_TIMEOUT_MS })).stdout
        : await runScript(loc.remote!, INFO_SCRIPT, [], PEER_SCRIPT_TIMEOUT_MS);
    return parseConnInfo(stdout);
  } catch {
    return null; // узел лёг/недоступен — эту ссылку просто пропускаем, не роняем всю подписку
  }
}

/** Та же ссылка, что выдаёт add-vless-ws-tls-peer.sh, но для уже существующего uuid,
 *  с учётом релея локации, если он включён (см. locations.ts::getClientEndpoint). */
export function buildLink(pubkey: string, loc: Location, info: ConnInfo): string {
  const wsPath = info.wsPath.replace(/\//g, '%2F');
  const link = `vless://${pubkey}@${info.domain}:${info.port}?type=ws&security=tls&sni=${info.domain}&host=${info.domain}&path=${wsPath}&encryption=none#${encodeURIComponent(loc.title)}`;
  const relay = getClientEndpoint(loc.id);
  return relay ? withVlessHostPort(link, relay.host, relay.port) : link;
}

/** Ссылки клиента по всем его локациям, которые сейчас поднимаются (недоступные — пропущены). */
export async function subscriptionLinks(sub: Sub): Promise<string[]> {
  const links: string[] = [];
  for (const peer of sub.peers) {
    const loc = findLocation(peer.loc);
    if (!loc) continue;
    const info = await readConnInfo(loc);
    if (!info) continue;
    links.push(buildLink(peer.pubkey, loc, info));
  }
  return links;
}

/** Тело ответа подписки: base64 от списка ссылок, по одной на строку — формат,
 *  который понимают клиенты вроде OneXray/v2rayNG без ручного импорта. */
export async function subscriptionBody(sub: Sub): Promise<string> {
  const links = await subscriptionLinks(sub);
  return Buffer.from(links.join('\n'), 'utf8').toString('base64');
}

/** Токен подписки — pubkey первого пира. Он и так секрет (даёт доступ к VPN),
 *  отдельный токен заводить незачем — было бы вторым секретом ради того же самого. */
export function subscriptionToken(sub: Sub): string | null {
  return sub.peers[0]?.pubkey ?? null;
}

export function findSubByToken(token: string): Sub | null {
  for (const sub of allSubs()) {
    if (sub.peers.some((p) => p.pubkey === token)) return sub;
  }
  return null;
}

// Телеметрия обращений к подписке. Без веб-панели: владелец смотрит через /subs
// в самом боте-продавце (см. index.ts) — та же идея, что у stats.ts, свой файл,
// чтобы не путать с покупками.
const ACCESS_FILE = path.join(config.dataDir, 'subs-access.jsonl');

interface AccessEv {
  token: string;
  ts: number;
  ok: boolean; // false — токен не нашли или подписка истекла
  links: number; // сколько ссылок реально собралось (0 при ok=false)
}

function recordSubAccess(e: AccessEv): void {
  try {
    appendFileSync(ACCESS_FILE, JSON.stringify(e) + '\n');
  } catch {
    /* телеметрия не должна ронять выдачу подписки */
  }
}

function readAccessLog(): AccessEv[] {
  if (!existsSync(ACCESS_FILE)) return [];
  return readFileSync(ACCESS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as AccessEv;
      } catch {
        return null;
      }
    })
    .filter((e): e is AccessEv => e !== null);
}

/** Экспортирована ради тестов (форматирование времени в /subs). */
export function fmtAgo(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}

/** Сводка для владельца: кто реально пользуется подпиской (а не просто купил ключ). */
export function buildSubStats(): string {
  const log = readAccessLog();
  if (log.length === 0) {
    return '📡 Подписка\n\nОбращений ещё не было — клиенты подключаются по ссылке напрямую.';
  }
  const byToken = new Map<string, AccessEv[]>();
  for (const e of log) byToken.set(e.token, [...(byToken.get(e.token) ?? []), e]);

  const dayAgo = Date.now() - 24 * 3_600_000;
  const activeToday = [...byToken.values()].filter((evs) => evs.some((e) => e.ts >= dayAgo)).length;
  const badTokens = [...byToken.entries()].filter(([, evs]) => evs.every((e) => !e.ok));

  const lines = [
    '📡 Подписка',
    '',
    `Всего обращений: ${log.length}`,
    `Разных клиентов: ${byToken.size} (за сутки — ${activeToday})`,
  ];
  if (badTokens.length > 0) {
    lines.push(`⚠️ Битые/просроченные токены: ${badTokens.length}`);
  }
  lines.push('', 'Последние обращения:');
  const recent = [...log].sort((a, b) => b.ts - a.ts).slice(0, 10);
  for (const e of recent) {
    const sub = e.ok ? findSubByToken(e.token) : null;
    const who = sub?.username ? '@' + sub.username : sub?.userId ? String(sub.userId) : e.token.slice(0, 8) + '…';
    lines.push(`• ${who} — ${fmtAgo(e.ts)}${e.ok ? ` (${e.links} серв.)` : ' ❌'}`);
  }
  return lines.join('\n');
}

/** GET /sub/<token> — используется из общего HTTPS-сервера (см. tribute.ts). */
export async function handleSubscriptionRequest(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  try {
    const sub = findSubByToken(token);
    if (!sub) {
      recordSubAccess({ token, ts: Date.now(), ok: false, links: 0 });
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('подписка не найдена');
      return;
    }
    if (sub.expiresAt < Date.now()) {
      recordSubAccess({ token, ts: Date.now(), ok: false, links: 0 });
      res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('срок подписки истёк');
      return;
    }
    const links = await subscriptionLinks(sub);
    recordSubAccess({ token, ts: Date.now(), ok: true, links: links.length });
    const body = Buffer.from(links.join('\n'), 'utf8').toString('base64');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  } catch (e) {
    console.error('Ошибка отдачи подписки:', e);
    if (!res.headersSent) res.writeHead(500).end();
  }
}

/** Полный URL подписки, чтобы показать владельцу/клиенту. */
export function subscriptionUrl(domain: string, port: number, token: string): string {
  return `https://${domain}:${port}/sub/${token}`;
}
