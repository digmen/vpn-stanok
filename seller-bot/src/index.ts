import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { createVpnPeer } from './vpn.js';
import { offerConfig, registerDeliveryHandlers } from './delivery.js';
import { claimOwnerIfUnset, getOwnerId } from './owner.js';
import { readOwnerConfig, saveOwnerConfig } from './owner-config.js';
import { buildStats, recordEvent } from './stats.js';

const bot = new Bot(config.botToken);
registerDeliveryHandlers(bot);

// Последнее меню в чате — чтобы удалять старое при новом /start (чат не засоряется).
const lastMenu = new Map<number, number>();

function mainMenu(isOwner: boolean): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard()
    .text(`🛒 Купить VPN за ${config.priceStars} ⭐`, 'buy')
    .row()
    .url('💰 Заработай на своём VPN так же', config.stanokUrl);
  if (isOwner) {
    kb.row().text('🆓 Мой VPN', 'free').text('📊 Статистика', 'stats');
  }
  const text =
    'Быстрый VPN за ⭐️ Telegram Stars.\n\n' +
    `Доступ на ${config.days} дней — ${config.priceStars} ⭐.\n` +
    'После оплаты выберешь формат конфига для приложения AmneziaVPN.';
  return { text, kb };
}

bot.command('start', async (ctx) => {
  claimOwnerIfUnset(ctx.from!.id);
  const isOwner = ctx.from?.id === getOwnerId();
  const chatId = ctx.chat.id;

  // Убираем прошлое меню, чтобы не копились
  const prev = lastMenu.get(chatId);
  if (prev) await ctx.api.deleteMessage(chatId, prev).catch(() => {});

  const { text, kb } = mainMenu(isOwner);
  const m = await ctx.reply(text, { reply_markup: kb });
  lastMenu.set(chatId, m.message_id);
});

bot.callbackQuery('buy', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.replyWithInvoice(
    'VPN-доступ',
    `Доступ к VPN на ${config.days} дней`,
    'vpn-access',
    'XTR', // Telegram Stars
    [{ label: `VPN ${config.days} дн.`, amount: config.priceStars }],
  );
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('message:successful_payment', async (ctx) => {
  recordEvent({ type: 'paid', stars: ctx.message.successful_payment.total_amount, userId: ctx.from.id });
  await issueVpn(ctx.api, ctx.chat.id);
});

// Владелец берёт бесплатный доступ — один постоянный конфиг (без новых пиров на каждый клик)
bot.callbackQuery('free', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from?.id !== getOwnerId()) return;
  const chatId = ctx.chat!.id;

  const existing = readOwnerConfig();
  if (existing) {
    await offerConfig(ctx.api, chatId, existing);
    return;
  }

  const wait = await ctx.api.sendMessage(chatId, '⏳ Генерирую твой VPN…');
  try {
    const cfg = await createVpnPeer();
    saveOwnerConfig(cfg);
    recordEvent({ type: 'free', userId: getOwnerId() });
    await ctx.api.deleteMessage(chatId, wait.message_id).catch(() => {});
    await offerConfig(ctx.api, chatId, cfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Выдача VPN не удалась:', msg);
    await ctx.api.editMessageText(chatId, wait.message_id, '❌ Не получилось выдать VPN.\n\nТех. детали:\n' + msg).catch(() => {});
  }
});

// Статистика — редактируем то же сообщение меню (владельцу)
bot.callbackQuery('stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from?.id !== getOwnerId()) return;
  const back = new InlineKeyboard().text('← Назад', 'menu');
  await ctx.editMessageText(await buildStats(), { reply_markup: back }).catch(() => {});
});

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const { text, kb } = mainMenu(ctx.from?.id === getOwnerId());
  await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
});

bot.command('stats', async (ctx) => {
  if (ctx.from?.id !== getOwnerId()) return;
  await ctx.reply(await buildStats());
});

async function issueVpn(api: typeof bot.api, chatId: number): Promise<void> {
  const wait = await api.sendMessage(chatId, '⏳ Генерирую VPN…');
  try {
    const cfg = await createVpnPeer();
    await api.deleteMessage(chatId, wait.message_id).catch(() => {});
    await offerConfig(api, chatId, cfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Выдача VPN не удалась:', msg);
    await api
      .editMessageText(chatId, wait.message_id, '❌ Не получилось выдать VPN.\n\nТех. детали:\n' + msg)
      .catch(() => {});
  }
}

bot.catch((err) => console.error('Ошибка бота-продавца:', err));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({
  onStart: (info) => console.log(`Бот-продавец @${info.username} запущен`),
});
