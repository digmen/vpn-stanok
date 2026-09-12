import { InlineKeyboard, type Api } from 'grammy';
import { config } from './config.js';
import { db, getNodesByUser, getReadyPrimaryNodes } from './db.js';
import { logEvent } from './events.js';
import { kvInit } from './kv.js';
import { loadUserStates, toMs, type UserState } from './analytics.js';
import { buyGuideText, renewReminderText } from './host-guide.js';

// Напоминания тем, кто застрял на полпути.
//
// 🔴 13.09, журнал станка: из 70 человек 28 ушли сразу после /start, 18 — на вводе IP,
// и больше в бот не возвращались. Им никто не писал: бот отвечал только на нажатия.
//
// Правила, чтобы это было помощью, а не спамом:
//   - только тем, кто пришёл ПОСЛЕ включения напоминаний (kv nudges_since) — старых
//     пользователей это не касается, писать им — отдельное решение владельца станка;
//   - одно напоминание на этап и не больше двух на человека вообще, между ними сутки;
//   - только днём по Москве, и не раньше, чем человек несколько часов ничего не делал;
//   - в каждом — кнопка «Не напоминать», после неё тишина навсегда;
//   - через 14 дней после прихода — не пишем совсем.

export type NudgeKind = 'n_buy' | 'n_ip' | 'n_server' | 'n_provision';

const H = 3600_000;
const MAX_PER_USER = 2;
const GIVE_UP_AFTER = 14 * 24 * H;

/** Что сейчас стоит напомнить этому человеку (или ничего). Чистая функция — под тесты. */
export function decideNudge(u: UserState, now: number, since: number): NudgeKind | null {
  if (u.off || u.failsBeforeOk !== null || u.best === null) return null;
  if (u.firstAt < since || now - u.firstAt > GIVE_UP_AFTER) return null;
  if (u.nudges.length >= MAX_PER_USER) return null;
  const lastNudge = Math.max(0, ...u.nudges.map((n) => n.at));
  if (now - lastNudge < 24 * H) return null;
  const idle = now - u.lastAt;
  const sent = new Set(u.nudges.map((n) => n.kind));
  const pick = (k: NudgeKind, minIdle: number) => (idle >= minIdle && !sent.has(k) ? k : null);

  switch (u.best) {
    case 'start':
      return pick('n_buy', 3 * H);
    case 'bought_click':
    case 'setup_click':
      return pick('n_ip', 6 * H);
    case 'ip_ok':
      return pick('n_server', 6 * H);
    case 'preflight_ok':
    case 'password_ok':
    case 'token_ok':
      return pick('n_provision', 6 * H);
    default:
      // «Поднять VPN» нажал, установка упала — об этом уже знает админ, он и пишет.
      return null;
  }
}

/** Днём по Москве (UTC+3), чтобы не будить. */
export function isDaytimeMsk(now: number): boolean {
  const h = (new Date(now).getUTCHours() + 3) % 24;
  return h >= 10 && h < 21;
}

const offBtn = (kb: InlineKeyboard) => kb.row().text('🔕 Не напоминать', 'nudge_off');

function nudgeMessage(kind: NudgeKind, userId: number): { text: string; kb: InlineKeyboard } | null {
  switch (kind) {
    case 'n_buy':
      return {
        text: 'Привет! Ты заходил настроить свой VPN, но до сервера не дошёл. Вот всё по шагам 👇\n\n' + buyGuideText(),
        kb: offBtn(new InlineKeyboard().url('🌐 Открыть хостинг', config.referralLink).row().text('✅ Я купил сервер', 'bought')),
      };
    case 'n_ip':
      return {
        text:
          'Настройка остановилась на IP сервера.\n\n' +
          'Где его взять: панель хостинга → твой сервер → строка «IP-адрес» (четыре числа через точку). ' +
          'Он же приходит в письме после покупки.\n\n' +
          'Сервера ещё нет — жми «Как купить», там всё по шагам.',
        kb: offBtn(new InlineKeyboard().text('⚙️ Продолжить настройку', 'setup').row().text('🛒 Как купить сервер', 'buy')),
      };
    case 'n_server':
      return {
        text:
          'Твой сервер в прошлый раз не ответил, и настройка встала.\n\n' +
          'Почти всегда причина одна: не куплен «Выделенный IP». Его можно добавить к уже купленному ' +
          'серверу: панель хостинга → твой сервер → услуга «Выделенный IP» (~50–65 ₽). ' +
          'Потом возьми новый адрес оттуда и продолжи.',
        kb: offBtn(new InlineKeyboard().text('⚙️ Продолжить настройку', 'setup')),
      };
    case 'n_provision': {
      const node = getNodesByUser(userId)
        .filter((n) => n.status !== 'ready')
        .sort((a, b) => b.id - a.id)[0];
      if (!node) return null;
      return {
        text: 'Данные сервера приняты, осталась одна кнопка — «Поднять VPN». Всё остальное я сделаю сам.',
        kb: offBtn(new InlineKeyboard().text('🚀 Поднять VPN', `provision:${node.id}`)),
      };
    }
  }
}

function nudgesSince(): number {
  return toMs(kvInit('nudges_since', new Date().toISOString().slice(0, 19).replace('T', ' ')));
}

async function send(api: Api, userId: number, username: string | null, kind: string, text: string, kb?: InlineKeyboard) {
  const who = { id: userId, username: username ?? undefined };
  try {
    await api.sendMessage(userId, text, { reply_markup: kb });
    logEvent(who, 'nudge', kind);
  } catch (e) {
    // Заблокировал бота — пишем как отправленное, чтобы не стучаться снова.
    logEvent(who, 'nudge', `${kind} не доставлено: ${String(e).slice(0, 80)}`);
  }
}

/** Один проход: застрявшим — по напоминанию, узлам на 6-й день — про продление сервера. */
export async function runNudges(api: Api, now = Date.now()): Promise<void> {
  const since = nudgesSince();
  if (!isDaytimeMsk(now)) return;

  for (const u of loadUserStates()) {
    const kind = decideNudge(u, now, since);
    if (!kind) continue;
    const m = nudgeMessage(kind, u.id);
    if (m) await send(api, u.id, u.username, kind, m.text, m.kb);
  }

  // Продление: сервер с бесплатной недели умирает на 8-й день вместе с узлом и его клиентами.
  // Узел никто не предупреждал — и первые узлы так и пропали на шестой-седьмой день.
  for (const n of getReadyPrimaryNodes()) {
    const created = toMs(n.created_at);
    const age = now - created;
    if (created < since || age < 6 * 24 * H || age > 8 * 24 * H) continue;
    const tag = `n_renew #${n.id}`;
    const already = db
      .prepare(`SELECT 1 FROM events WHERE tg_user_id = ? AND step = 'nudge' AND detail LIKE ? LIMIT 1`)
      .get(n.tg_user_id, tag + '%');
    if (already) continue;
    await send(
      api,
      n.tg_user_id,
      n.tg_username,
      tag,
      renewReminderText(),
      new InlineKeyboard().url('🌐 Открыть хостинг', config.referralLink),
    );
  }
}
