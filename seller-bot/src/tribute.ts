import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './settings.js';

/**
 * Приём оплаты картой и СБП через Tribute (tribute.tg) — рядом со звёздами Telegram.
 *
 * Зачем: звёзды покупаются не всеми и не везде, а часть клиентов просто хочет заплатить
 * картой. У Александра (отдельный проект) это уже работало на его сервере; здесь то же
 * самое сделано возможностью франшизы — владелец подключает свой Tribute сам, из своего
 * бота, ничего не прося у нас и не показывая нам свой ключ.
 *
 * 🔴 Отличие от первого варианта: там товары прописывались руками строкой в .env
 * ("<id>:<slug>:<loc>:<pkg>"), и на этом обожглись дважды — у товара в Tribute ДВА
 * идентификатора (числовой в вебхуке и буквенный в ссылке), их перепутали, кнопка вела
 * в никуда. Здесь владелец не вводит идентификаторы вообще: бот берёт список товаров из
 * API по его же ключу и знает оба значения сразу.
 */

const TRIBUTE_API = 'https://tribute.tg/api/v1';

export interface TributeProduct {
  id: string;
  name: string;
  /** Цена в копейках/центах — так отдаёт API. */
  amount: number;
  currency: string;
  webLink: string;
}

/**
 * Что владелец на самом деле прислал вместо ключа. Разбор вынесен сюда из обработчика
 * ровно затем, чтобы его можно было проверить тестами: цена ошибки — человек с виду
 * подключил оплату, а она молчит.
 *
 * Терпимо к копипасте: кавычки, приставка «Api-Key:» из документации, пробелы по краям.
 */
export function classifyKeyInput(raw: string): { kind: 'link' | 'bot-token' | 'short' | 'ok'; key: string } {
  const key = raw
    .replace(/^\s*api[-_ ]?key\s*[:=]?\s*/i, '')
    .replace(/^["'«<]+|["'»>]+$/g, '')
    .trim();
  if (/^https?:\/\//i.test(key) || key.startsWith('t.me/') || key.startsWith('web.tribute.tg')) {
    return { kind: 'link', key };
  }
  if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(key)) return { kind: 'bot-token', key };
  // Ключ Tribute заметно длиннее: короткая строка — почти наверняка обрезанная копипаста.
  // Ровно это и прислали 08.09: 32 символа вместо полного ключа.
  if (key.length < 16) return { kind: 'short', key };
  return { kind: 'ok', key };
}

export type KeyVerdict =
  | { ok: true; rows: TributeProduct[] }
  // 'invalid' — точный факт: Tribute сказал «не тот ключ».
  // 'network' — приговор НЕ ключу: не достучались, ответ непонятный, таймаут.
  // Путать эти два — значит либо сохранить нерабочий ключ, либо выбросить рабочий.
  | { ok: false; reason: 'invalid' | 'network'; detail: string };

/** Проверка ключа с честным разделением «ключ не тот» и «не смогли проверить». */
export async function verifyTributeKey(apiKey: string): Promise<KeyVerdict> {
  try {
    return { ok: true, rows: await fetchTributeProducts(apiKey) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg === INVALID_KEY ? 'invalid' : 'network', detail: msg };
  }
}

const INVALID_KEY = 'ключ не подошёл';

/** Товары владельца в Tribute. Ошибку не глотаем: по ней бот объясняет, что именно не так. */
export async function fetchTributeProducts(apiKey: string): Promise<TributeProduct[]> {
  const res = await fetch(`${TRIBUTE_API}/products?size=100`, {
    headers: { 'Api-Key': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error(INVALID_KEY);
  if (!res.ok) throw new Error(`Tribute ответил ${res.status}`);
  const body = (await res.json()) as { rows?: unknown };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => r.id !== undefined && typeof r.webLink === 'string')
    .map((r) => ({
      id: String(r.id),
      name: typeof r.name === 'string' ? r.name : 'без названия',
      amount: typeof r.amount === 'number' ? r.amount : 0,
      currency: typeof r.currency === 'string' ? r.currency.toUpperCase() : '',
      webLink: String(r.webLink),
    }));
}

/** «12900 RUB» → «129 ₽». Цену за карту назначает владелец в Tribute, мы только показываем. */
export function priceLabel(p: { amount: number; currency: string }): string {
  const whole = p.amount / 100;
  const sum = Number.isInteger(whole) ? String(whole) : whole.toFixed(2);
  const sign = p.currency === 'RUB' ? '₽' : p.currency === 'USD' ? '$' : p.currency === 'EUR' ? '€' : p.currency;
  return `${sum} ${sign}`;
}

export interface TributeWebhookEvent {
  name: string;
  created_at?: string;
  // payload может отсутствовать: служебные и тестовые события (кнопка «Отправить тестовый
  // запрос» в кабинете Tribute) приходят как {name, created_at}. Не выдумка — поймано
  // вживую 30.08, и необработанное обращение к payload роняло тогда весь процесс бота.
  payload?: Record<string, unknown> & {
    telegram_user_id?: number;
    // Тип честно широкий: в живом логе id приезжал числом, хотя документация обещает строку.
    product_id?: string | number;
    subscription_id?: number;
    period_id?: number;
    purchase_id?: string;
    amount?: number;
    currency?: string;
  };
}

export type TributeEventHandler = (ev: TributeWebhookEvent) => Promise<void>;

/**
 * Что за событие пришло. Имя сравниваем без регистра и подчёркиваний намеренно:
 * документация Tribute пишет `newDigitalProduct`, а живой вебхук приходил как
 * `new_digital_product`. Гадать, какое из двух настоящее, — значит однажды не выдать
 * ключ человеку, который уже заплатил.
 */
export function eventKind(name: string): 'purchase' | 'refund' | 'other' {
  const n = name.toLowerCase().replace(/[_-]/g, '');
  if (n === 'newdigitalproduct' || n === 'newsubscription' || n === 'renewedsubscription') return 'purchase';
  if (n === 'digitalproductrefund' || n === 'cancelledsubscription') return 'refund';
  return 'other';
}

// Дедуп переживает рестарт: Tribute ретраит недоставленный вебхук до ~24 ч
// (5м/15м/30м/1ч/2ч/4ч/8ч/8ч), а pm2 может перезапуститься внутри этого окна.
const DEDUP_FILE = path.join(config.dataDir, 'tribute-seen.json');
const DEDUP_TTL_MS = 48 * 60 * 60 * 1000;

function loadSeen(): Record<string, number> {
  if (!existsSync(DEDUP_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DEDUP_FILE, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

function markSeen(key: string): boolean {
  const seen = loadSeen();
  const now = Date.now();
  for (const k of Object.keys(seen)) {
    if (now - seen[k] > DEDUP_TTL_MS) delete seen[k];
  }
  if (seen[key] !== undefined) return false;
  seen[key] = now;
  try {
    writeFileSync(DEDUP_FILE, JSON.stringify(seen));
  } catch {
    /* не критично: в худшем случае ретрай обработается дважды */
  }
  return true;
}

/** Ключ идемпотентности — из самого информативного поля события. */
export function dedupeKey(ev: TributeWebhookEvent): string {
  const p = ev.payload ?? {};
  if (p.purchase_id) return `purchase:${p.purchase_id}`;
  if (p.subscription_id !== undefined && p.period_id !== undefined) return `sub:${p.subscription_id}:${p.period_id}`;
  return `raw:${ev.name}:${p.telegram_user_id}:${p.product_id ?? p.subscription_id}:${ev.created_at}`;
}

export function verifySignature(rawBody: string, signature: string | undefined, apiKey: string): boolean {
  if (!apiKey || !signature) return false;
  const expected = createHmac('sha256', apiKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // timingSafeEqual на разной длине буферов бросает исключение, а не возвращает false.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Сертификат узла — тот же, которым живёт VLESS+WS+TLS. */
function certFiles(): { cert: string; key: string } | null {
  if (!config.nodeDomain) return null;
  const dir = `/etc/letsencrypt/live/${config.nodeDomain}`;
  const cert = path.join(dir, 'fullchain.pem');
  const key = path.join(dir, 'privkey.pem');
  return existsSync(cert) && existsSync(key) ? { cert, key } : null;
}

/** Адрес, который владелец вставляет в кабинете Tribute. null — вебхук физически негде принять. */
export function webhookUrl(): string | null {
  if (!config.nodeDomain || !certFiles()) return null;
  return `https://${config.nodeDomain}:${config.tributeWebhookPort}/tribute`;
}

/**
 * Что вообще происходило на приёме оплат. Нужно ровно затем, чтобы владелец мог САМ
 * увидеть, дошли ли до него события Tribute, — «оплата не работает» без этого
 * неотличимо от «ещё ни разу не пробовали».
 */
export interface TributeStatus {
  /** Последнее событие с правильной подписью. */
  lastEventAt?: number;
  lastEventName?: string;
  /** Последний приход с НЕВЕРНОЙ подписью: почти всегда значит, что ключ у нас не тот. */
  lastBadSigAt?: number;
  delivered: number;
  rejected: number;
}

const STATUS_FILE = path.join(config.dataDir, 'tribute-status.json');

export function tributeStatus(): TributeStatus {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as TributeStatus;
  } catch {
    return { delivered: 0, rejected: 0 };
  }
}

function noteStatus(patch: (s: TributeStatus) => TributeStatus): TributeStatus {
  const next = patch(tributeStatus());
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(next));
  } catch {
    /* статистика приёма — не повод ронять приём */
  }
  return next;
}

/**
 * Проверка «а дойдёт ли до меня вообще»: бот стучится на свой же публичный адрес.
 * Ответ 401 — лучший из возможных: значит порт открыт, сертификат принят, сервер живой
 * и подпись он проверяет. Молчание — значит Tribute тоже не достучится.
 */
export async function selfCheck(): Promise<{ ok: boolean; text: string }> {
  const url = webhookUrl();
  if (!config.nodeDomain) return { ok: false, text: 'у этого сервера нет доменного имени — принять оплату картой он не сможет' };
  if (!certFiles()) return { ok: false, text: `нет сертификата для ${config.nodeDomain} — принять оплату картой нельзя` };
  if (!server) return { ok: false, text: 'приём выключен — включи оплату картой, тогда бот начнёт слушать' };
  try {
    const res = await fetch(url!, {
      method: 'POST',
      body: '{"name":"selfcheck"}',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { ok: true, text: 'адрес доступен снаружи, сертификат в порядке, подпись проверяется' };
    return { ok: false, text: `адрес ответил ${res.status} — ожидался 401` };
  } catch (e) {
    return { ok: false, text: `по своему же адресу достучаться не удалось: ${e instanceof Error ? e.message : e}` };
  }
}

let server: Server | null = null;
let certStamp = '';
let handler: TributeEventHandler | null = null;
let onIssue: ((s: TributeStatus) => void) | null = null;

function certVersion(files: { cert: string; key: string }): string {
  try {
    return String(statSync(files.cert).mtimeMs);
  } catch {
    return '';
  }
}

/**
 * Поднимает (или гасит) приём вебхуков по текущим настройкам. Зовётся при старте и после
 * каждой правки владельцем: включил оплату картой — приём заработал, без перезапуска бота.
 *
 * Сервер именно HTTPS и на отдельном порту: 443 на узле занят самим VPN, а 80 обязан
 * оставаться свободным — через него certbot продлевает сертификат.
 */
export function syncTributeServer(onEvent?: TributeEventHandler, onBadSignature?: (s: TributeStatus) => void): void {
  if (onEvent) handler = onEvent;
  if (onBadSignature) onIssue = onBadSignature;
  const s = getSettings().tribute;
  const files = certFiles();
  const want = s.enabled && s.apiKey !== null && files !== null && handler !== null;

  if (!want) {
    if (server) {
      server.close();
      server = null;
      certStamp = '';
    }
    return;
  }
  // Сертификат перевыпускается раз в ~60 дней, а процесс живёт дольше: сервер со старым
  // сертификатом однажды молча перестал бы принимать оплату. Поэтому смена файла — повод
  // пересоздать сервер, а не повод для ручного вмешательства.
  const stamp = certVersion(files);
  if (server && stamp === certStamp) return;
  if (server) server.close();
  certStamp = stamp;

  server = createServer({ cert: readFileSync(files.cert), key: readFileSync(files.key) }, (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // Весь обработчик в try/catch намеренно: необработанное исключение здесь роняет весь
      // процесс, то есть все продажи бота, а не только приём одного вебхука.
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const sigHeader = req.headers['trbt-signature'];
        const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
        const apiKey = getSettings().tribute.apiKey ?? '';

        if (!verifySignature(rawBody, signature, apiKey)) {
          // Чужой стук по открытому порту тоже сюда попадает, поэтому не паникуем, а
          // записываем: если ЭТО единственное, что приходит, значит ключ у нас не тот —
          // Tribute подписывает как раз им. Владелец увидит это на экране настройки.
          const st = noteStatus((s) => ({ ...s, lastBadSigAt: Date.now(), rejected: s.rejected + 1 }));
          if (onIssue && signature) onIssue(st);
          res.writeHead(401).end();
          return;
        }

        let ev: TributeWebhookEvent;
        try {
          const parsed: unknown = JSON.parse(rawBody);
          if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
          ev = parsed as TributeWebhookEvent;
        } catch {
          res.writeHead(400).end();
          return;
        }

        // Отвечаем сразу: выдача ключа (SSH на сервер, отправка в Telegram) бывает дольше
        // таймаута Tribute, а лишний ретрай из-за нашей медлительности плодит дубликаты.
        res.writeHead(200).end();
        noteStatus((s) => ({ ...s, lastEventAt: Date.now(), lastEventName: ev.name, delivered: s.delivered + 1 }));
        if (!markSeen(dedupeKey(ev))) return;
        void handler!(ev).catch((e) => console.error('Ошибка обработки вебхука Tribute:', e));
      } catch (e) {
        console.error('Ошибка приёма вебхука Tribute (не уронила бота):', e);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    req.on('error', () => res.writeHead(400).end());
  });

  server.on('error', (e) => console.error('Tribute: сервер вебхуков не поднялся:', e));
  server.listen(config.tributeWebhookPort, '0.0.0.0', () => {
    console.log(`Tribute: принимаю оплату на ${webhookUrl()}`);
  });
}

/** Раз в сутки проверяем, не перевыпущен ли сертификат (см. syncTributeServer). */
export function watchTributeCert(): void {
  setInterval(() => syncTributeServer(), 24 * 60 * 60 * 1000).unref();
}
