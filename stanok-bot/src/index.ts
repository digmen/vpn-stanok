import { Bot, InlineKeyboard, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { config } from './config.js';
import { getNodesByUser } from './db.js';
import { onboarding, type MyContext } from './onboarding.js';
import { provisionNode } from './provision.js';

const bot = new Bot<MyContext>(config.botToken);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(onboarding));

// ── Шаг 1: купить сервер ────────────────────────────────────────────────
bot.command('start', async (ctx) => {
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
      'Нажми «Купить сервер» — на сайте всё понятно. Если хочешь пошагово, с видео — ' +
      'жми «Подробная инструкция».\n\n' +
      'Купил? Жми «Я купил сервер».',
    { reply_markup: kb },
  );
});

bot.callbackQuery('instr', async (ctx) => {
  await ctx.answerCallbackQuery();
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
      '2. Выбери тариф — обязательно с выделенным IP и системой Ubuntu.\n' +
      '3. Оплати картой с телефона.\n' +
      '4. Вернись сюда и жми «Я купил сервер».',
  );
});

// ── Шаг 2: настроить ────────────────────────────────────────────────────
bot.callbackQuery('bought', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('⚙️ Настроить', 'setup');
  // Морфим то же сообщение в Шаг 2 — чат не засоряется
  await ctx.editMessageText(
    '📍 Шаг 2. Настройка сервера\n\n' +
      'Сейчас я попрошу дать доступ к серверу, чтобы настроить его в автоматическом режиме.\n\n' +
      'Мне нужны:\n' +
      '1. IP\n' +
      '2. Пароль\n' +
      '3. Токен бота — его можно получить, создав бота через @BotFather\n\n' +
      'К каждому шагу буду давать инструкцию.\n\n' +
      'Жми «Настроить».',
    { reply_markup: kb },
  );
});

bot.callbackQuery('setup', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {}); // убираем сообщение Шага 2, чтобы не висело
  await ctx.conversation.enter('onboarding');
});

// ── Провижининг: поднять VPN ────────────────────────────────────────────
bot.callbackQuery(/^provision:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const nodeId = Number(ctx.match[1]);
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

await bot.start({
  onStart: (info) => console.log(`Станок-бот @${info.username} запущен`),
});
