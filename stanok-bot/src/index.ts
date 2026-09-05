import { Bot, InlineKeyboard, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { config } from './config.js';
import {
  getAllNodes,
  getNodeById,
  getNodesByUser,
  getReadyNodes,
  getRevenueShareNodes,
  setRevenueSharePercent,
} from './db.js';
import { onboarding, type MyContext } from './onboarding.js';
import { provisionNode } from './provision.js';
import { notifyAdmins } from './admin.js';
import { checkNodeAlive } from './ssh.js';
import { logEvent } from './events.js';
import { decrypt } from './crypto.js';
import { commission, revenueReport, syncNode } from './revenue.js';

const bot = new Bot<MyContext>(config.botToken);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(onboarding));

// ── Шаг 1: купить сервер ────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  logEvent(ctx.from!, 'start');
  const kb = new InlineKeyboard()
    .url('🛒 Купить сервер', config.referralLink)
    .row()
    .text('📄 Подробная инструкция', 'instr')
    .row()
    .text('✅ Я купил сервер', 'bought');

  await ctx.reply(
    'Привет! 👋\n\n' +
      'Здесь ты за пару минут получишь свой VPN-сервер и бота, через которого сможешь ' +
      'продавать VPN за ⭐️ Telegram Stars.\n\n' +
      '━━━━━━━━━━━━━━\n' +
      '📍 Шаг 1. Купи сервер\n' +
      'Нажми «Купить сервер», выбери Ubuntu — и обязательно отметь галочку «Выделенный IP».\n\n' +
      '⚠️ Про выделенный IP без шуток: он стоит ~50–65 ₽, и без него ничего не заработает. ' +
      'Сервер без него спрятан за NAT хостинга — ни я не смогу его настроить, ни твои клиенты ' +
      'не подключатся к VPN. Это причина 9 из 10 неудач.\n\n' +
      'Хочешь пошагово, с видео — жми «Подробная инструкция».\n' +
      'Купил? Жми «Я купил сервер».',
    { reply_markup: kb },
  );
});

bot.callbackQuery('instr', async (ctx) => {
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, 'instr_open');
  if (config.videos.buy) {
    try {
      await ctx.replyWithVideo(config.videos.buy);
    } catch {
      /* file_id недоступен */
    }
  }
  await ctx.reply(
    'Коротко:\n' +
      '1. Жми «Купить сервер».\n' +
      '2. Выбери тариф с системой Ubuntu.\n' +
      '3. ⚠️ Отметь «Выделенный IP» — это отдельная услуга за ~50–65 ₽, и она обязательна. ' +
      'Без неё сервер снаружи не виден: ни настроить, ни раздать VPN не получится.\n' +
      '4. Оплати картой с телефона.\n' +
      '5. Вернись сюда и жми «Я купил сервер».\n\n' +
      'Если сервер уже куплен без выделенного IP — не страшно: услугу можно добавить ' +
      'в панели к существующему серверу.',
  );
});

// ── Шаг 2: настроить ────────────────────────────────────────────────────
bot.callbackQuery('bought', async (ctx) => {
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, 'bought_click');
  const kb = new InlineKeyboard().text('⚙️ Настроить', 'setup');
  // Морфим то же сообщение в Шаг 2 — чат не засоряется
  await ctx.editMessageText(
    '📍 Шаг 2. Настройка сервера\n\n' +
      'Сейчас я попрошу дать доступ к серверу, чтобы настроить его в автоматическом режиме.\n\n' +
      'Мне нужны:\n' +
      '1. IP — сразу проверю, отвечает ли сервер\n' +
      '2. Пароль (спрошу, только если сервер отозвался)\n' +
      '3. Токен бота — его можно получить, создав бота через @BotFather\n\n' +
      'К каждому шагу буду давать инструкцию.\n\n' +
      'Жми «Настроить».',
    { reply_markup: kb },
  );
});

bot.callbackQuery('setup', async (ctx) => {
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, 'setup_click');
  await ctx.deleteMessage().catch(() => {}); // убираем сообщение Шага 2, чтобы не висело
  await ctx.conversation.enter('onboarding');
});

// ── Провижининг: поднять VPN ────────────────────────────────────────────
bot.callbackQuery(/^provision:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const nodeId = Number(ctx.match[1]);
  logEvent(ctx.from, 'provision_click', String(nodeId));
  // Редактируем то же сообщение («Данные приняты»), а не плодим новые
  await provisionNode(ctx.api, ctx.chat!.id, nodeId, ctx.callbackQuery.message?.message_id);
});

// ── Служебное ───────────────────────────────────────────────────────────
bot.command('status', async (ctx) => {
  const nodes = getNodesByUser(ctx.from!.id);
  if (nodes.length === 0) {
    await ctx.reply('Заявок пока нет. Нажми /start и настрой сервер.');
    return;
  }
  const lines = nodes.map((n) => `#${n.id} · ${n.server_ip} · ${n.status}`).join('\n');
  await ctx.reply('Твои серверы:\n' + lines);
});

bot.command('help', async (ctx) => {
  await ctx.reply('/start — начать\n/status — статус твоих серверов');
});

// Мониторинг всех узлов (только админ): статус + живая проверка доступности
bot.command('nodes', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const nodes = getAllNodes();
  if (nodes.length === 0) {
    await ctx.reply('Узлов пока нет.');
    return;
  }
  const lines = await Promise.all(
    nodes.map(async (n) => {
      const health =
        n.status === 'ready'
          ? await checkNodeAlive(n.server_ip, decrypt(n.root_password_enc), !!n.is_primary)
          : { ok: false, detail: 'status ≠ ready' };
      return `#${n.id} ${health.ok ? '🟢' : '🔴'} ${n.server_ip} · ${n.status} · @${n.tg_username ?? '—'}${health.ok ? '' : ` · ${health.detail}`}`;
    }),
  );
  await ctx.reply('Узлы:\n' + lines.join('\n'));
});

// Выручка узлов (только админ). Основание для процента с продаж.
//
// 🔒 Узлы об этом не знают и знать не должны — сбор молчаливый, на их стороне
// ничего не меняется (см. revenue.ts). Команда админская: чужой /revenue
// просто игнорируется, как и /nodes.
bot.command('revenue', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const arg = (ctx.match ?? '').trim();

  // /revenue share <id> <percent|off> — включить/выключить долю на конкретном
  // узле. Единственное место, откуда это вообще берётся: по умолчанию НИ У
  // КОГО доли нет (см. миграция 06.09 в db.ts) — договорённость такого рода
  // заводится явно, руками, на того одного человека, с кем она реально есть.
  const shareMatch = arg.match(/^share\s+(\d+)\s+(off|\d{1,3})$/);
  if (shareMatch) {
    const nodeId = Number(shareMatch[1]);
    const node = getNodeById(nodeId);
    if (!node) {
      await ctx.reply(`Узла #${nodeId} нет.`);
      return;
    }
    if (shareMatch[2] === 'off') {
      setRevenueSharePercent(nodeId, null);
      await ctx.reply(`Доля с продаж для узла #${nodeId} выключена — станок его больше не трогает.`);
    } else {
      const percent = Number(shareMatch[2]);
      if (percent < 1 || percent > 100) {
        await ctx.reply('Процент — число от 1 до 100.');
        return;
      }
      setRevenueSharePercent(nodeId, percent);
      await ctx.reply(`Узел #${nodeId} (@${node.tg_username ?? node.server_ip}): включена доля ${percent}%.`);
    }
    return;
  }

  // `/revenue sync` идёт по серверам, но только по тем, где доля реально включена —
  // ходить в SSH к остальным читать их подписки не за чем и не по праву.
  if (arg === 'sync') {
    const wait = await ctx.reply('⏳ Обхожу узлы с включённой долей…');
    const nodes = getRevenueShareNodes();
    if (nodes.length === 0) {
      await ctx.api
        .editMessageText(ctx.chat.id, wait.message_id, 'Ни у одного узла не включена доля с продаж — обходить некого.')
        .catch(() => {});
      return;
    }
    const results = await Promise.all(nodes.map((n) => syncNode(n)));
    const failed = results.filter((r) => !r.ok);
    const added = results.reduce((s, r) => s + r.added, 0);
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        wait.message_id,
        `Готово. Узлов: ${results.length}, новых продаж: ${added}.` +
          (failed.length ? `\n\nНе ответили: ${failed.map((f) => `#${f.nodeId}`).join(', ')}` : ''),
      )
      .catch(() => {});
    return;
  }

  const rows = revenueReport();
  if (rows.length === 0) {
    await ctx.reply(
      'Ни у одного узла не включена доля с продаж — отчёту не по чему считать.\n\n' +
        '/revenue share <id> <процент|off> — включить/выключить на конкретном узле.',
    );
    return;
  }
  const lines = rows.map((r) => {
    const who = r.username ? '@' + r.username : r.serverIp;
    const week = r.weekStars > 0 ? `${r.weekStars} ⭐ (${r.weekCount})` : '—';
    return (
      `#${r.nodeId} ${who}\n` +
      `   за неделю: ${week} · твои ${r.sharePercent}%: ${commission(r.weekStars, r.sharePercent)} ⭐\n` +
      `   всего: ${r.totalStars} ⭐ за ${r.totalCount} продаж` +
      (r.trials ? ` · пробных ${r.trials}` : '')
    );
  });
  const weekTotal = rows.reduce((s, r) => s + r.weekStars, 0);
  const weekCommission = rows.reduce((s, r) => s + commission(r.weekStars, r.sharePercent), 0);
  await ctx.reply(
    lines.join('\n\n') +
      `\n\n💰 Итого за неделю: ${weekTotal} ⭐ · твои: ${weekCommission} ⭐` +
      '\n\n/revenue sync — обойти узлы прямо сейчас' +
      '\n/revenue share <id> <процент|off> — включить/выключить на узле',
  );
});

// Админ присылает медиа → бот возвращает file_id (чтобы вставить в .env как видео-инструкцию).
bot.on(['message:video', 'message:animation', 'message:document', 'message:photo'], async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const msg = ctx.message;
  const fileId =
    msg?.video?.file_id ??
    msg?.animation?.file_id ??
    msg?.document?.file_id ??
    msg?.photo?.at(-1)?.file_id;
  if (fileId) {
    await ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: 'HTML' });
  }
});

bot.catch((err) => console.error('Ошибка бота:', err));

// Аккуратная остановка
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

// Мониторинг узлов: раз в 30 мин проверяем доступность, алертим админам об изменениях
const offlineNodes = new Set<number>();
async function monitorNodes(): Promise<void> {
  for (const n of getReadyNodes()) {
    const health = await checkNodeAlive(n.server_ip, decrypt(n.root_password_enc), !!n.is_primary);
    if (!health.ok && !offlineNodes.has(n.id)) {
      offlineNodes.add(n.id);
      await notifyAdmins(
        bot.api,
        `🔴 Узел #${n.id} (${n.server_ip}, @${n.tg_username ?? '—'}) недоступен: ${health.detail}`,
      );
    } else if (health.ok && offlineNodes.has(n.id)) {
      offlineNodes.delete(n.id);
      await notifyAdmins(bot.api, `🟢 Узел #${n.id} (${n.server_ip}) снова онлайн.`);
    }
  }
}
setInterval(() => void monitorNodes(), 30 * 60 * 1000);

// Сбор выручки узлов: раз в 6 часов молча читаем subs.json — но ТОЛЬКО у узлов,
// которым явно включена доля с продаж (см. db.ts::getRevenueShareNodes). До
// 06.09 это шло по ВСЕМ узлам разом с общим 5% — договорённость такого рода
// реально была только с одним человеком, для остальных это был необоснованный
// SSH-заход на чужой сервер и лишний алерт себе же. Пусто по умолчанию — цикл
// просто ничего не делает, пока кому-то явно не включат.
//
// Почему регулярно, а не по запросу (для тех, кому включено): узел может
// почистить файл, потерять сервер или переустановить бота — увиденная продажа
// остаётся в базе станка навсегда. Раз в 6 часов, а не раз в сутки: так пропажа
// сервера отнимает максимум несколько продаж, а не целый день.
async function collectRevenue(): Promise<void> {
  for (const n of getRevenueShareNodes()) {
    const r = await syncNode(n);
    if (r.ok && r.added > 0) {
      await notifyAdmins(bot.api, `💰 Узел #${n.id} (@${n.tg_username ?? n.server_ip}): +${r.added} продаж. /revenue`);
    }
  }
}
setInterval(() => void collectRevenue(), 6 * 60 * 60 * 1000);
void collectRevenue(); // первый заход сразу при старте

await bot.start({
  onStart: (info) => console.log(`Станок-бот @${info.username} запущен`),
});
