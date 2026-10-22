import { isAuthFailure } from './preflight.js';

// Простой бота владельца: когда сообщать ему самому.
//
// 🔴 22.10: у Рамазана (#19) сервер пересоздали, бот пропал, 15 сообщений его клиентов
// висели без ответа 5 суток — а станок один раз написал админу «недоступен» и замолчал,
// владельцу не сообщив вовсе. Теперь о простое больше суток узнаёт сам владелец.
//
// Сигнал «бот молчит» не зависит от SSH: живой бот забирает сообщения из Telegram за
// доли секунды, и getWebhookInfo показывает 0 необработанных. Если их стабильно больше
// нуля — бот не опрашивает Telegram (процесс лёг, сервер пересоздан, Telegram режется).
// Так ловятся и узлы, на которые станок давно не может зайти по паролю.

export const SILENT_AFTER_MS = 24 * 3600_000;
export const REMIND_EVERY_MS = 72 * 3600_000;
export const MAX_ALERTS = 3;

export interface OwnerDowntime {
  /** С какого момента непрерывно плохо (ms). */
  since: number;
  /** Сколько сообщений владельцу уже ушло. */
  notified: number;
  /** Когда ушло последнее (ms), 0 — не уходило. */
  lastAt: number;
}

export type DowntimeAction = 'none' | 'alert' | 'remind' | 'recovered';

/** Чистое решение: что делать на этом замере. Состояние хранит вызывающий. */
export function decideOwnerAlert(
  state: OwnerDowntime | null,
  bad: boolean,
  now: number,
): { state: OwnerDowntime | null; action: DowntimeAction } {
  if (!bad) {
    // Выздоровление объявляем только тому, кому писали о проблеме: иначе «снова в порядке»
    // придёт из ниоткуда.
    return { state: null, action: state && state.notified > 0 ? 'recovered' : 'none' };
  }
  if (!state) return { state: { since: now, notified: 0, lastAt: 0 }, action: 'none' };
  if (state.notified === 0) {
    if (now - state.since >= SILENT_AFTER_MS) {
      return { state: { ...state, notified: 1, lastAt: now }, action: 'alert' };
    }
    return { state, action: 'none' };
  }
  if (state.notified < MAX_ALERTS && now - state.lastAt >= REMIND_EVERY_MS) {
    return { state: { ...state, notified: state.notified + 1, lastAt: now }, action: 'remind' };
  }
  return { state, action: 'none' };
}

export type DowntimeCause = 'password' | 'server' | 'bot';

/**
 * Почему молчит. По тексту последней неудачи проверки здоровья:
 *  - пароль не подходит → сервер, скорее всего, пересоздали;
 *  - проверка не прошла по другой причине → сервер или VPN не отвечают;
 *  - проверка в порядке (или её не было) → сервер жив, но бот не забирает сообщения.
 */
export function downtimeCause(lastHealthOk: number | null, healthDetail: string | null): DowntimeCause {
  // Проверка не прошла, но текста неудачи нет (запись ещё не появилась после деплоя) — причину
  // не знаем, «сервер лёг» не заявляем: на этом узле может быть просто устаревший пароль.
  if (lastHealthOk === 0 && healthDetail) {
    return isAuthFailure(healthDetail) ? 'password' : 'server';
  }
  return 'bot';
}

const HOW_TO_SETUP =
  'Открой @VPNForge_bot → /start → «Я купил сервер» → «Настроить», пришли IP и root-пароль сервера. ' +
  'Токен твоего бота у меня сохранён, остальное я сделаю сам.';

/** Текст владельцу. Без сырых ошибок: что случилось и что делать. */
export function ownerDowntimeMessage(
  cause: DowntimeCause,
  botName: string | null,
  kind: 'alert' | 'remind',
): string {
  const who = botName ? `@${botName}` : 'твой VPN-бот';
  const head =
    kind === 'alert'
      ? `⚠️ ${who} не отвечает клиентам уже больше суток.`
      : `⏰ Напоминаю: ${who} по-прежнему не отвечает клиентам.`;
  switch (cause) {
    case 'password':
      return (
        `${head}\n\nСтанок больше не может зайти на твой сервер: пароль не подходит. Почти всегда это значит, ` +
        'что сервер переустановили или пересоздали — тогда бот и VPN на нём пропали вместе с системой.\n\n' +
        `Чтобы всё вернуть: ${HOW_TO_SETUP}\n\n` +
        'Если сервер ты закрыл сам и бот больше не нужен — просто проигнорируй это сообщение.'
      );
    case 'server':
      return (
        `${head}\n\nСервер или VPN на нём не отвечают. Частая причина — закончился оплаченный срок у хостинга ` +
        'или сервер выключен. Проверь в панели хостинга, что он включён и оплачен.\n\n' +
        'Если там всё в порядке — напиши в @VPNForgeSupport_bot, разберёмся.'
      );
    case 'bot':
      return (
        `${head}\n\nСервер на связи, но сам бот не забирает сообщения из Telegram. Чаще всего процесс бота упал ` +
        'или в Telegram перевыпустили токен.\n\n' +
        'Напиши в @VPNForgeSupport_bot, я посмотрю и подскажу.'
      );
  }
}

export function ownerRecoveredMessage(botName: string | null): string {
  return `✅ ${botName ? '@' + botName : 'Твой VPN-бот'} снова отвечает клиентам. Спасибо, что разобрался.`;
}

/**
 * «Молчит ли бот» — решает Telegram, а не доступ станка к серверу.
 *  - необработанные сообщения есть → бот не забирает их → молчит;
 *  - их нет, но станок не может ЗАЙТИ (пароль устарел) → это не признак, что бот плох: на сегодня
 *    10 узлов именно такие, и боты у большинства живы (проверено 22.10) — не пугаем владельцев зря;
 *  - их нет, но сервер реально не отвечает (не пароль) → сервер лёг, бот тоже.
 */
export function isOwnerBotSilent(pending: number, lastHealthOk: number | null, healthDetail: string | null): boolean {
  if (pending > 0) return true;
  return downtimeCause(lastHealthOk, healthDetail) === 'server';
}
