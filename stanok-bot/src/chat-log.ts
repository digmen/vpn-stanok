import { createHash } from 'node:crypto';
import type { Context, NextFunction, Transformer } from 'grammy';
import { config } from './config.js';
import { db } from './db.js';
import { NOT_IP_PREFIX } from './validate.js';

// Журнал диалога со станком в обе стороны: что человек прислал и что бот ему ответил.
//
// Зачем (13.09): журнал шагов (events.ts) показывает, ГДЕ человек упал, но не ЧТО он видел
// и что пытался сделать. 22 человека 109 раз получили «это не похоже на IP» — а что они
// присылали, узнать было неоткуда. Историю переписки Telegram боту не отдаёт вообще
// (метода «прочитать прошлые сообщения» у Bot API нет), поэтому видно только то, что бот
// записал сам в момент события.
//
// 🔒 Секреты сюда не попадают — это правило кода:
//   - root-пароль: пока мастер ждёт пароль, на человеке стоит отметка (secret_wait),
//     и его ответ пишется как «[пароль скрыт]». Отметка в БД, а не в памяти процесса —
//     переживает рестарт станка посреди шага;
//   - токены ботов, ключи и конфиги VPN вырезаются регуляркой из ЛЮБОГО текста, в обе стороны.

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id  INTEGER NOT NULL,
    tg_username TEXT,
    dir         TEXT NOT NULL,           -- 'in' — от человека, 'out' — от бота
    kind        TEXT NOT NULL,           -- text | button | command | media | edit
    text        TEXT,
    dedup       TEXT UNIQUE,             -- одно событие = одна строка, даже при повторном вызове
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_log(tg_user_id, id);

  CREATE TABLE IF NOT EXISTS secret_wait (
    tg_user_id INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const MAX_TEXT = 1500;

const TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g;
const LINK_RE = /\b(vless|vmess|trojan|ss|hysteria2|hy2|tuic|wireguard|awg):\/\/\S+/gi;
const PRIVKEY_RE = /(PrivateKey|PresharedKey|privateKey)\s*[=:]\s*\S+/g;

/** Вырезает всё, что даёт доступ: токены ботов, ключи и конфиги VPN. */
export function redact(text: string): string {
  let t = text;
  if (/\[Interface\]/i.test(t) && /PrivateKey/i.test(t)) return '[конфиг VPN скрыт]';
  t = t.replace(TOKEN_RE, '[токен скрыт]');
  t = t.replace(LINK_RE, (_m, scheme: string) => `[ключ ${scheme.toLowerCase()} скрыт]`);
  t = t.replace(PRIVKEY_RE, (_m, k: string) => `${k} = [скрыт]`);
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
}

export type SecretKind = 'password';

export function markSecretWait(tgUserId: number, kind: SecretKind): void {
  try {
    db.prepare(
      `INSERT INTO secret_wait (tg_user_id, kind) VALUES (?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET kind = excluded.kind, at = datetime('now')`,
    ).run(tgUserId, kind);
  } catch {
    /* журнал не должен ронять бота */
  }
}

export function clearSecretWait(tgUserId: number): void {
  try {
    db.prepare('DELETE FROM secret_wait WHERE tg_user_id = ?').run(tgUserId);
  } catch {
    /* см. выше */
  }
}

function secretWaitOf(tgUserId: number): SecretKind | null {
  const row = db.prepare('SELECT kind FROM secret_wait WHERE tg_user_id = ?').get(tgUserId) as
    | { kind: SecretKind }
    | undefined;
  return row?.kind ?? null;
}

function insert(row: {
  tgUserId: number;
  username?: string | null;
  dir: 'in' | 'out';
  kind: string;
  text: string;
  dedup: string;
}): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO chat_log (tg_user_id, tg_username, dir, kind, text, dedup)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.tgUserId, row.username ?? null, row.dir, row.kind, row.text, row.dedup);
  } catch {
    /* журнал не должен ронять бота */
  }
}

type Btn = { text: string; callback_data?: string; url?: string };

function buttonsOf(markup: unknown): string {
  const rows = (markup as { inline_keyboard?: Btn[][] } | undefined)?.inline_keyboard;
  if (!rows?.length) return '';
  const labels = rows.flat().map((b) => b.text);
  return labels.length ? `\n[кнопки: ${labels.join(' | ')}]` : '';
}

/** Что пришло от человека. Ставится ДО мастера настройки, чтобы видеть и его шаги. */
export async function logIncoming(ctx: Context, next: NextFunction): Promise<void> {
  try {
    const from = ctx.from;
    if (from && ctx.chat?.type === 'private') {
      const dedup = `u:${ctx.update.update_id}`;
      const base = { tgUserId: from.id, username: from.username, dir: 'in' as const, dedup };
      const msg = ctx.message;
      if (msg?.text !== undefined) {
        const t = msg.text.trim();
        const secret = t.startsWith('/') ? null : secretWaitOf(from.id);
        if (secret === 'password') insert({ ...base, kind: 'text', text: '[пароль скрыт]' });
        else insert({ ...base, kind: t.startsWith('/') ? 'command' : 'text', text: redact(t) });
      } else if (msg) {
        const what = msg.photo
          ? 'фото'
          : msg.video
            ? 'видео'
            : msg.document
              ? 'файл'
              : msg.sticker
                ? 'стикер'
                : msg.voice
                  ? 'голосовое'
                  : 'сообщение';
        const caption = msg.caption ? ': ' + redact(msg.caption) : '';
        insert({ ...base, kind: 'media', text: `[${what}]${caption}` });
      } else if (ctx.callbackQuery?.data !== undefined) {
        const data = ctx.callbackQuery.data;
        const rows = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []) as Btn[][];
        const label = rows.flat().find((b) => b.callback_data === data)?.text;
        insert({ ...base, kind: 'button', text: label ? `«${label}»` : `[кнопка ${data}]` });
      }
    }
  } catch {
    /* журнал не должен ронять бота */
  }
  await next();
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * Что бот отправил. Трансформер API: видит каждый вызов, какой бы код его ни сделал
 * (мастер, провижининг, монитор, напоминания).
 *
 * Внутри мастера grammY может проигрывать код заново — поэтому запись идемпотентна:
 * ключ = чат + номер сообщения + текст. Повтор того же вызова даёт ту же строку.
 */
export const logOutgoing: Transformer = async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  try {
    const p = payload as Record<string, unknown>;
    const chatId = Number(p.chat_id);
    // Админу бот шлёт тревоги и отчёты (в т.ч. /chat с чужими диалогами) — это не диалог
    // с клиентом, и журнал разбухал бы копиями чужих переписок.
    if (res.ok && Number.isFinite(chatId) && chatId > 0 && !config.adminIds.includes(chatId)) {
      const result = res.result as { message_id?: number } | true;
      const msgId = typeof result === 'object' && result ? result.message_id : (p.message_id as number | undefined);
      let kind: string | null = null;
      let text = '';
      if (method === 'sendMessage') {
        kind = 'text';
        text = String(p.text ?? '');
      } else if (method === 'editMessageText') {
        kind = 'edit';
        text = String(p.text ?? '');
      } else if (method === 'sendVideo' || method === 'sendPhoto' || method === 'sendDocument' || method === 'sendAnimation') {
        kind = 'media';
        text = `[${method.slice(4).toLowerCase()}]` + (p.caption ? ' ' + String(p.caption) : '');
      }
      if (kind) {
        const full = redact(text) + buttonsOf(p.reply_markup);
        insert({
          tgUserId: chatId,
          dir: 'out',
          kind,
          text: full,
          dedup: `o:${chatId}:${msgId ?? 'x'}:${hash(full)}`,
        });
      }
    }
  } catch {
    /* журнал не должен ронять бота */
  }
  return res;
};

export interface ChatRow {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  dir: 'in' | 'out';
  kind: string;
  text: string | null;
  created_at: string;
}

/** Telegram id по @username — ищем в обоих журналах. */
export function resolveUser(who: string): number | null {
  const asId = Number(who);
  if (Number.isFinite(asId) && asId > 0) return asId;
  const uname = who.replace(/^@/, '');
  const row =
    (db.prepare('SELECT tg_user_id FROM chat_log WHERE tg_username = ? COLLATE NOCASE LIMIT 1').get(uname) as
      | { tg_user_id: number }
      | undefined) ??
    (db.prepare('SELECT tg_user_id FROM events WHERE tg_username = ? COLLATE NOCASE LIMIT 1').get(uname) as
      | { tg_user_id: number }
      | undefined);
  return row?.tg_user_id ?? null;
}

/** Последние N строк диалога, в хронологическом порядке. */
export function chatTranscript(tgUserId: number, limit = 60): ChatRow[] {
  return (
    db
      .prepare('SELECT * FROM chat_log WHERE tg_user_id = ? ORDER BY id DESC LIMIT ?')
      .all(tgUserId, limit) as ChatRow[]
  ).reverse();
}

export function lastIncomingAt(tgUserId: number): string | null {
  const row = db
    .prepare(`SELECT MAX(created_at) at FROM chat_log WHERE tg_user_id = ? AND dir = 'in'`)
    .get(tgUserId) as { at: string | null };
  return row.at;
}

/** Журнал — разбор, а не архив: старше полугода не нужен. */
export function pruneChatLog(days = 180): void {
  try {
    db.prepare(`DELETE FROM chat_log WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
  } catch {
    /* см. выше */
  }
}

/** Что именно люди присылали вместо IP — по этому чинится подсказка. */
export function rejectedIpInputs(limit = 30): { text: string; times: number }[] {
  // Отказ «это не IP» — ответ бота; вход человека — строка прямо перед ним.
  return db
    .prepare(
      `SELECT i.text text, COUNT(*) times
         FROM chat_log o
         JOIN chat_log i ON i.id = (
           SELECT MAX(id) FROM chat_log WHERE tg_user_id = o.tg_user_id AND dir = 'in' AND id < o.id)
        WHERE o.dir = 'out' AND o.text LIKE ? || '%'
        GROUP BY i.text ORDER BY times DESC LIMIT ?`,
    )
    .all(NOT_IP_PREFIX, limit) as { text: string; times: number }[];
}
