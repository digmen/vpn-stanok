import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { createVpnPeer, revokePeer, type Peer } from './vpn.js';
import { addSubscription, getExpired, removeSubscription } from './subscriptions.js';
import { offerConfig, registerDeliveryHandlers } from './delivery.js';
import { claimOwnerIfUnset, getOwnerId } from './owner.js';
import { readOwnerConfig, saveOwnerConfig } from './owner-config.js';
import { getPrice, isValidPrice, setPrice } from './price.js';
import { buildStats, recordEvent } from './stats.js';

const bot = new Bot(config.botToken);
registerDeliveryHandlers(bot);

// Владелец, от которого сейчас ждём новую цену (простое состояние без conversations).
let awaitingPriceFrom: number | null = null;
let awaitingSince = 0;
const PRICE_PROMPT_TTL_MS = 120_000; // окно ввода цены — 2 минуты

const isOwner = (id?: number): boolean => id !== undefined && id === getOwnerId();

function mainMenu(owner: boolean): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard()
    .text(`🛒 Купить VPN за ${getPrice()} ⭐`, 'buy')
    .row()
    .url('💰 Заработай на своём VPN так же', config.stanokUrl);
  if (owner) {
    kb.row().text('🆓 Мой VPN', 'free').text('📊 Статистика', 'stats');
    kb.row().text('💲 Изменить цену', 'setprice');
  }
  const text =
    'Быстрый VPN за ⭐️ Telegram Stars.\n\n' +
    `Доступ на ${config.days} дней — ${getPrice()} ⭐.\n` +
    'После оплаты выберешь формат конфига для приложения AmneziaVPN.';
  return { text, kb };
}

// Последнее меню в чате — удаляем старое при новом /start (чат не засоряется).
const lastMenu = new Map<number, number>();

bot.command('start', async (ctx) => {
  awaitingPriceFrom = null; // ушёл в меню — режим ввода цены сбрасываем
  claimOwnerIfUnset(ctx.from!.id);
  const chatId = ctx.chat.id;

  const prev = lastMenu.get(chatId);
  if (prev) await ctx.api.deleteMessage(chatId, prev).catch(() => {});

  const { text, kb } = mainMenu(isOwner(ctx.from?.id));
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
    [{ label: `VPN ${config.days} дн.`, amount: getPrice() }],
  );
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('message:successful_payment', async (ctx) => {
  recordEvent({ type: 'paid', stars: ctx.message.successful_payment.total_amount, userId: ctx.from.id });
  await issuePaidVpn(ctx.api, ctx.chat.id);
});

// Владелец берёт бесплатный доступ — один постоянный конфиг (без новых пиров на каждый клик)
bot.callbackQuery('free', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const chatId = ctx.chat!.id;

  const existing = readOwnerConfig();
  if (existing) {
    await offerConfig(ctx.api, chatId, existing);
    return;
  }
  const peer = await generate(ctx.api, chatId);
  if (peer) {
    saveOwnerConfig(peer.config);
    recordEvent({ type: 'free', userId: getOwnerId() });
    await offerConfig(ctx.api, chatId, peer.config);
  }
});

// Статистика — редактируем то же сообщение меню (владельцу)
bot.callbackQuery('stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const back = new InlineKeyboard().text('← Назад', 'menu');
  await ctx.editMessageText(await buildStats(), { reply_markup: back }).catch(() => {});
});

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const { text, kb } = mainMenu(isOwner(ctx.from?.id));
  await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
});

// Владелец меняет цену
bot.callbackQuery('setprice', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  awaitingPriceFrom = ctx.from.id;
  awaitingSince = Date.now();
  const kb = new InlineKeyboard().text('❌ Отмена', 'cancelprice');
  await ctx.reply(`Пришли новую цену за ${config.days} дней в звёздах (число). Сейчас: ${getPrice()} ⭐`, {
    reply_markup: kb,
  });
});

bot.callbackQuery('cancelprice', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from?.id === awaitingPriceFrom) awaitingPriceFrom = null;
  await ctx.editMessageText('Изменение цены отменено.').catch(() => {});
});

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(await buildStats());
});

// Ввод новой цены владельцем (перехватываем только когда ждём — иначе не мешаем).
bot.on('message:text', async (ctx) => {
  if (awaitingPriceFrom === null || ctx.from?.id !== awaitingPriceFrom) return;
  // окно ввода истекло — молча выходим из режима, не жуём чужой текст
  if (Date.now() - awaitingSince > PRICE_PROMPT_TTL_MS) {
    awaitingPriceFrom = null;
    return;
  }
  const n = Number(ctx.message.text.trim());
  if (!isValidPrice(n)) {
    await ctx.reply('❌ Нужно целое число от 1, либо нажми «Отмена».');
    return;
  }
  setPrice(n);
  awaitingPriceFrom = null;
  await ctx.reply(`✅ Цена обновлена: ${n} ⭐ за ${config.days} дней.`);
});

// ── выдача VPN ────────────────────────────────────────────────────────────
async function generate(api: typeof bot.api, chatId: number): Promise<Peer | null> {
  const wait = await api.sendMessage(chatId, '⏳ Генерирую VPN…');
  try {
    const peer = await createVpnPeer();
    await api.deleteMessage(chatId, wait.message_id).catch(() => {});
    return peer;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Выдача VPN не удалась:', msg);
    await api.editMessageText(chatId, wait.message_id, '❌ Не получилось выдать VPN.\n\nТех. детали:\n' + msg).catch(() => {});
    return null;
  }
}

async function issuePaidVpn(api: typeof bot.api, chatId: number): Promise<void> {
  const peer = await generate(api, chatId);
  if (!peer) return;
  await offerConfig(api, chatId, peer.config);
  addSubscription(peer.pubkey, config.days); // истечёт через config.days — потом автоотзыв
}

// Раз в час отзываем истёкшие подписки (удаляем пиры с сервера)
async function sweepExpired(): Promise<void> {
  for (const pubkey of getExpired()) {
    try {
      await revokePeer(pubkey);
      removeSubscription(pubkey); // убираем из хранилища только после успешного отзыва
      console.log('Отозван истёкший ключ:', pubkey);
    } catch (e) {
      console.error('Не удалось отозвать ключ (повторим позже):', e instanceof Error ? e.message : e);
    }
  }
}

bot.catch((err) => console.error('Ошибка бота-продавца:', err));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

setInterval(() => void sweepExpired(), 60 * 60 * 1000); // проверка истёкших раз в час
void sweepExpired();

await bot.start({
  onStart: (info) => console.log(`Бот-продавец @${info.username} запущен`),
});
