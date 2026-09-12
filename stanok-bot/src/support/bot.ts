/**
 * Бот техподдержки станка (@VPNForgeSupport_bot) — отдельный процесс на той же базе.
 *
 * Человек пишет → обращение #N → админу приходит карточка: докуда он дошёл в станке,
 * его узлы, подписка на канал, прошлые обращения — и само сообщение. Админ отвечает
 * ОТВЕТОМ на карточку или на сообщение — бот пересылает ответ человеку. Всё пишется:
 * история каждого обращения, время до первого ответа, помогла ли поддержка дойти до узла.
 *
 * Сборка бота отдельно от запуска — чтобы гонять его в прогоне без Telegram.
 */
import { Api, Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { logEvent } from '../events.js';
import { redact } from '../chat-log.js';
import { checkSubscribed } from '../channel.js';
import { kvGet, kvSet } from '../kv.js';
import { toMs } from '../analytics.js';
import {
  addMessage,
  addRoute,
  closeTicket,
  createTicket,
  getTicket,
  openTicketOf,
  openTickets,
  reopenTicket,
  routeOf,
  ticketMessages,
  ticketsOf,
} from './store.js';
import { autoHint, openList, stageOf, stanokTail, supportStats, ticketCard } from './context.js';

/** Бот поддержки. stanokApi — для проверки подписки на канал (админ канала — станок). */
export function createSupportBot(token: string, stanokApi: Api): Bot {
  const bot = new Bot(token);
  const isAdmin = (id?: number) => id !== undefined && config.adminIds.includes(id);

  const MENU = new Keyboard().text('📥 Открытые').text('📊 Статистика').resized().persistent();

  const cardKb = (id: number) =>
    new InlineKeyboard()
      .text('✅ Закрыть', `close:${id}`)
      .row()
      .text('📜 Что было в станке', `stanok:${id}`)
      .text('🗂 История', `hist:${id}`);

  function who(ctx: Context): string {
    return ctx.from?.username ? '@' + ctx.from.username : `id ${ctx.from?.id}`;
  }

  function describe(ctx: Context): string {
    const m = ctx.message!;
    if (m.text) return m.text;
    const kind = m.photo ? 'фото' : m.video ? 'видео' : m.document ? 'файл' : m.voice ? 'голосовое' : m.sticker ? 'стикер' : 'сообщение';
    return `[${kind}]` + (m.caption ? ' ' + m.caption : '');
  }

  // ── Админ ───────────────────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id)) return next();

    if (ctx.message?.text === '/start') {
      await ctx.reply('Ты админ поддержки. Обращения приходят сюда карточками — отвечай ответом на сообщение.', {
        reply_markup: MENU,
      });
      return;
    }
    if (ctx.message?.text === '📥 Открытые') {
      await ctx.reply(openList(openTickets()));
      return;
    }
    if (ctx.message?.text === '📊 Статистика') {
      await ctx.reply(supportStats());
      return;
    }

    // Ответ ответом на карточку/сообщение клиента → клиенту.
    const reply = ctx.message?.reply_to_message;
    if (ctx.message && reply) {
      const ticketId = routeOf(ctx.chat!.id, reply.message_id);
      const t = ticketId ? getTicket(ticketId) : undefined;
      if (!t) {
        await ctx.reply('Не понял, к какому обращению это. Ответь на карточку обращения или на сообщение клиента.');
        return;
      }
      try {
        if (ctx.message.text) {
          await ctx.api.sendMessage(t.tg_user_id, '🧑‍💻 Поддержка:\n' + ctx.message.text);
        } else {
          await ctx.api.copyMessage(t.tg_user_id, ctx.chat!.id, ctx.message.message_id);
        }
      } catch (e) {
        await ctx.reply(`❌ Не доставлено: ${String(e).slice(0, 150)}\nСкорее всего, он заблокировал бота.`);
        return;
      }
      if (t.status === 'closed') reopenTicket(t.id);
      addMessage(t.id, 'out', redact(describe(ctx)), ctx.from!.id);
      addRoute(ctx.chat!.id, ctx.message.message_id, t.id);
      await ctx.api
        .setMessageReaction(ctx.chat!.id, ctx.message.message_id, [{ type: 'emoji', emoji: '👍' }])
        .catch(() => {});
      return;
    }

    if (ctx.message) {
      await ctx.reply('Чтобы ответить клиенту — ответь на его карточку или сообщение (свайп влево / «Ответить»).', {
        reply_markup: MENU,
      });
      return;
    }
    return next();
  });

  bot.callbackQuery(/^close:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
    const t = getTicket(Number(ctx.match[1]));
    if (!t) return ctx.answerCallbackQuery({ text: 'Нет такого обращения' });
    const closed = closeTicket(t.id);
    await ctx.answerCallbackQuery({ text: closed ? `#${t.id} закрыто` : 'Уже закрыто' });
    if (closed) {
      await ctx.api
        .sendMessage(t.tg_user_id, `Обращение #${t.id} закрыто ✅ Если что-то ещё — просто напиши сюда.`)
        .catch(() => {});
      await ctx
        .editMessageReplyMarkup({
          reply_markup: new InlineKeyboard().text('📜 Что было в станке', `stanok:${t.id}`).text('🗂 История', `hist:${t.id}`),
        })
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^stanok:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx.from.id)) return;
    const t = getTicket(Number(ctx.match[1]));
    if (t) await ctx.reply(stanokTail(t.tg_user_id).slice(0, 3900));
  });

  bot.callbackQuery(/^hist:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx.from.id)) return;
    const t = getTicket(Number(ctx.match[1]));
    if (!t) return;
    const parts = ticketsOf(t.tg_user_id).map((x) => {
      const msgs = ticketMessages(x.id)
        .slice(-15)
        .map((m) => `${m.created_at.slice(5, 16)} ${m.dir === 'in' ? '👤' : '🧑‍💻'} ${(m.text ?? '').slice(0, 200)}`);
      return `#${x.id} · ${x.status === 'open' ? 'открыто' : 'закрыто'} · ${x.created_at.slice(0, 16)} · был: ${x.stage ?? '—'}\n${msgs.join('\n')}`;
    });
    await ctx.reply(('🗂 Обращения:\n\n' + parts.join('\n\n')).slice(0, 3900));
  });

  // ── Клиент ──────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const hint = autoHint(ctx.from!.id);
    await ctx.reply(
      'Привет! Это поддержка @VPNForge_bot 🧑‍💻\n\n' +
        'Напиши, что случилось, — можно со скрином. Я уже вижу, на каком шаге ты остановился в боте, ' +
        'так что пересказывать не нужно.\n\n' +
        '⚠️ Пароли от сервера сюда не присылай — они не нужны.' +
        (hint ? '\n\n💡 ' + hint : ''),
    );
  });

  bot.on('message', async (ctx) => {
    const from = ctx.from;
    if (!from || ctx.chat.type !== 'private') return;
    if (ctx.message.text?.startsWith('/')) return;

    let t = openTicketOf(from.id);
    const isNew = !t;
    if (!t) t = createTicket(from.id, from.username ?? null, stageOf(from.id));
    const text = describe(ctx);
    addMessage(t.id, 'in', redact(text));
    logEvent(from, 'support_msg', `#${t.id}`);

    const sub = isNew ? await checkSubscribed(stanokApi, from.id) : 'unknown';
    for (const admin of config.adminIds) {
      try {
        if (isNew) {
          const card = await ctx.api.sendMessage(admin, ticketCard(t, sub), { reply_markup: cardKb(t.id) });
          addRoute(admin, card.message_id, t.id);
        }
        const m = ctx.message.text
          ? await ctx.api.sendMessage(admin, `💬 #${t.id} ${who(ctx)}:\n${ctx.message.text}`)
          : await ctx.api.copyMessage(admin, ctx.chat.id, ctx.message.message_id, {
              caption: `💬 #${t.id} ${who(ctx)}` + (ctx.message.caption ? ':\n' + ctx.message.caption : ''),
            });
        addRoute(admin, m.message_id, t.id);
      } catch (e) {
        console.error('Не доставил админу', admin, e);
      }
    }

    if (isNew) {
      const hint = autoHint(from.id);
      await ctx.reply(
        `Принято ✅ Обращение #${t.id}. Ответ придёт сюда. Можешь дописать подробности или скрин.` +
          (hint ? '\n\n💡 Пока ждёшь: ' + hint : ''),
      );
    } else {
      await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '👀' }]).catch(() => {});
    }
  });

  bot.catch((err) => console.error('Ошибка поддержки:', err.error));
  return bot;
}

// Обращение без ответа 3+ часа — напомнить админу один раз (метка в kv переживает рестарт).
export async function remindUnanswered(bot: Bot): Promise<void> {
  for (const t of openTickets()) {
    if (t.first_reply_at || !t.last_in) continue;
    if (Date.now() - toMs(t.created_at) < 3 * 3600_000) continue;
    const key = `support_remind:${t.id}`;
    if (kvGet(key)) continue;
    kvSet(key, '1');
    for (const admin of config.adminIds) {
      await bot.api
        .sendMessage(admin, `⏰ Обращение #${t.id} (${t.tg_username ? '@' + t.tg_username : t.tg_user_id}) ждёт ответа больше 3 часов.`)
        .catch(() => {});
    }
  }
}

