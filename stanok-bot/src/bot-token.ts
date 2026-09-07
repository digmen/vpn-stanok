// 🔴 07.09, живой инцидент (Ramazan_LS, узел #19): владелец отозвал токен своего бота
// в @BotFather (обычное дело, когда у человека «всё сломалось» — он жмёт Revoke). Станок
// об этом не знал: развернул бота-продавца со СТАРЫМ токеном, тот получил от Telegram
// 401 Unauthorized, упал на старте — и pm2 поднимал его заново **2333 раза**, держа 100% CPU
// на сервере владельца. Никто ничего не заметил: ни владелец (бот молчит на /start), ни станок
// (монитор смотрит на сервер и VPN, но не на сам процесс бота).
//
// Отсюда правило: токен проверяется ДО того, как что-то на него разворачивать, и регулярно
// после. Проверка — getMe, самый дешёвый вызов Telegram, ничего не меняет.

export type TokenVerdict =
  /** Токен рабочий, бот существует. */
  | { ok: true; username: string | null }
  /** Telegram явно отверг токен (401) — отозван или удалён бот. Это точный факт. */
  | { ok: false; reason: 'invalid' }
  /** До Telegram не достучались. НЕ повод говорить человеку «твой токен мёртв» —
   *  вызывающий код должен трактовать это как «не знаю», а не как отказ. */
  | { ok: false; reason: 'network' };

export async function verifyBotToken(token: string, timeoutMs = 10_000): Promise<TokenVerdict> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error_code?: number;
      result?: { username?: string };
    };
    if (body.ok) return { ok: true, username: body.result?.username ?? null };
    // 401 — токен отозван/неверен. Всё остальное (429, 5xx) — не приговор токену.
    return body.error_code === 401 ? { ok: false, reason: 'invalid' } : { ok: false, reason: 'network' };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** Текст для владельца: что случилось и что нажать. Без слова «токен отозван» как обвинения —
 *  человек мог и не сам это сделать (бот удалён, перевыпущен помощником и т.п.). */
export const TOKEN_INVALID_HELP =
  '🔑 Telegram больше не принимает токен твоего бота-продавца — обычно так бывает, если токен ' +
  'перевыпустили в @BotFather.\n\n' +
  'Как взять новый:\n' +
  '1. Открой @BotFather → /mybots\n' +
  '2. Выбери своего бота → «API Token»\n' +
  '3. Скопируй строку вида 123456789:AAH...\n\n' +
  'Потом пришли его сюда — я сам всё перезапущу, заново ничего настраивать не нужно.';
