import { Bot, InlineKeyboard, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { config } from './config.js';
import { getAllNodes, getNodesByUser, getReadyNodes } from './db.js';
import { onboarding, type MyContext } from './onboarding.js';
import { provisionNode } from './provision.js';
import { notifyAdmins } from './admin.js';
import { checkNodeAlive } from './ssh.js';
import { decrypt } from './crypto.js';

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
      const up = n.status === 'ready' ? await checkNodeAlive(n.server_ip, decrypt(n.root_password_enc)) : false;
      return `#${n.id} ${up ? '🟢' : '🔴'} ${n.server_ip} · ${n.status} · @${n.tg_username ?? '—'}`;
    }),
  );
  await ctx.reply('Узлы:\n' + lines.join('\n'));
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
    const up = await checkNodeAlive(n.server_ip, decrypt(n.root_password_enc));
    if (!up && !offlineNodes.has(n.id)) {
      offlineNodes.add(n.id);
      await notifyAdmins(bot.api, `🔴 Узел #${n.id} (${n.server_ip}, @${n.tg_username ?? '—'}) недоступен.`);
    } else if (up && offlineNodes.has(n.id)) {
      offlineNodes.delete(n.id);
      await notifyAdmins(bot.api, `🟢 Узел #${n.id} (${n.server_ip}) снова онлайн.`);
    }
  }
}
setInterval(() => void monitorNodes(), 30 * 60 * 1000);

await bot.start({
  onStart: (info) => console.log(`Станок-бот @${info.username} запущен`),
});
