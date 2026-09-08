import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { config } from './config.js';
import { promoEnabled } from './branding.js';
import { markReminded, pendingReminders } from './reminders.js';
import {
  addPromo,
  allPromos,
  checkPromo,
  discountedStars,
  isValidCode,
  isValidPromoPercent,
  markPromoUsed,
  PROMO_LIMITS,
  removePromo,
} from './promos.js';
import {
  bankDays,
  bindReferral,
  inviteLink,
  parseCode,
  registerPurchase,
  statsFor,
  takeBanked,
} from './referrals.js';
import { createVpnPeer, createVpnPeerAt, createVpnPeersEverywhere, revokePeerAt, type Peer } from './vpn.js';
import { activeClients, addSubscription, addSubscriptionHours, extendForUser, getExpiredPeers, removePeer, revenueStars } from './subscriptions.js';
import { APPS, offerConfig, offerConfigs, registerDeliveryHandlers } from './delivery.js';
import {
  addRemote,
  allLocations,
  findLocation,
  LOCATION_LIMITS,
  parseHostPort,
  nextLocationId,
  PRIMARY_LOCATION_ID,
  remoteCount,
  removeRemote,
  renameLocation,
  saveKey,
  updateRemoteHost,
  type VpnProtocol,
} from './locations.js';
import { attachServer, ping } from './ssh.js';
import { claimOwnerIfUnset, getOwnerId } from './owner.js';
import { readOwnerConfig, saveOwnerConfig } from './owner-config.js';
import { buildStats, recordEvent } from './stats.js';
import { hasUsedTrial, markTrialUsed, trialCount } from './trials.js';
import { checkUpdate, currentVersion, startSelfUpdate } from './update.js';
import { logSetup } from './setup-log.js';
import {
  classifyKeyInput,
  eventKind,
  priceLabel,
  selfCheck,
  tributeStatus,
  verifyTributeKey,
  syncTributeServer,
  watchTributeCert,
  webhookUrl,
  type TributeProduct,
  type TributeWebhookEvent,
} from './tribute.js';
import {
  findPackage,
  getSettings,
  packageForTributeProduct,
  tributeUrlFor,
  humanHours,
  isValidDays,
  isValidHours,
  isValidPercent,
  isValidStars,
  LIMITS,
  nextPackageId,
  packageLabel,
  REMINDER_DAYS,
  updateSettings,
} from './settings.js';

const bot = new Bot(config.botToken);
registerDeliveryHandlers(bot);

/**
 * Решение 06.09 (прямое, без вариантов): в кнопке «Установить приложение» —
 * только OneXray. У продукта дальше один протокол — VLESS+Reality, AmneziaWG
 * новым узлам не предлагается вообще. Не гадать по локациям владельца.
 */
function appLinksText(): string {
  const a = APPS.vless_reality;
  return `📱 ${a.name}:\n• Android: ${a.android}\n• iPhone: ${a.ios}\n\nПоставь приложение заранее — после оплаты пришлю ключ.`;
}

// Владелец вводит значение текстом. Одно ожидание за раз — состояние простое и не переживает
// перезапуск специально: зависшее ожидание не должно жевать чужие сообщения.
type PendingKind =
  | 'pkg-price' | 'pkg-days' | 'pkg-new-days' | 'pkg-new-stars'
  | 'welcome-text' | 'welcome-photo' | 'trial-hours' | 'ref-percent' | 'promo-add' | 'tribute-key'
  // Добавление локации: сначала адрес, потом пароль, потом название
  | 'loc-host' | 'loc-password' | 'loc-title' | 'loc-rename' | 'loc-editip';
let pending: { kind: PendingKind; arg?: string; at: number } | null = null;
const PROMPT_TTL_MS = 180_000;

// Ожидание промокода от КЛИЕНТА. Отдельно от `pending`: тот один на весь бот и
// принадлежит владельцу — если пустить туда клиентов, двое одновременно затрут
// ввод друг друга. Здесь ключ на человека, и состояние живёт только в памяти:
// потерять его при перезапуске не страшно, человек просто нажмёт кнопку заново.
const awaitingPromo = new Map<number, number>();

const isOwner = (id?: number): boolean => id !== undefined && id === getOwnerId();
const expired = (): boolean => pending !== null && Date.now() - pending.at > PROMPT_TTL_MS;

function ask(kind: PendingKind, arg?: string): InlineKeyboard {
  pending = { kind, arg, at: Date.now() };
  return new InlineKeyboard().text('❌ Отмена', 'cancel');
}

// ── меню клиента: постоянная панель кнопок (reply-клавиатура) ──────────────
// Просьба франчайзи (Александр, 25.08): «панель кнопок, типо старт — писать
// команды неудобно, клиентам так проще». Раньше меню было inline ВНУТРИ
// сообщения: пролистал чат — и чтобы вернуться, набирай /start. Теперь панель
// висит внизу постоянно, команды не нужны. Дефолт для ВСЕХ ботов-продавцов
// (полезно каждому), не флаг на один бот — раскатается self-update'ом.
function welcomeText(): string {
  const s = getSettings();
  return (
    s.welcome.text ??
    'Быстрый VPN за ⭐️ Telegram Stars.\n\n' +
      'Выбери срок кнопкой ниже — после оплаты пришлю ключ и приложение под него.' +
      (s.trial.enabled ? '\n\nЕсть бесплатный пробный период — кнопка ниже.' : '')
  );
}

// 🔴 08.09: тарифы переехали из колонки в один ряд (его просьба). Надпись пришлось
// ужать: «🛒 30 дней — 50 ⭐» в три кнопки поперёк экрана телефона не влезает и
// обрезается многоточием. Цена внутри кнопки остаётся — это и просили.
// Текст кнопки здесь же и опознаётся при нажатии (см. bot.hears(/^🛒 /) ниже), поэтому
// формируется одной функцией: разъедутся — покупка перестанет находить тариф.
function buyButtonText(p: Parameters<typeof packageLabel>[0]): string {
  return `🛒 ${p.days} дн · ${p.stars}⭐`;
}

// Панель клиента: по кнопке на тариф, «попробовать», приложение, помощь;
// владельцу — вход в кабинет. resized — нормальная высота, persistent — панель
// не сворачивается после нажатия (то самое «всегда под рукой»).
function clientKeyboard(owner: boolean, userId?: number): Keyboard {
  const s = getSettings();
  const kb = new Keyboard();
  // Тарифы в ряд, по три в строке: 30/60/90 встают рядом одной полосой, а не
  // растягивают панель на три этажа. Больше трёх тарифов владелец завести может —
  // тогда просто переносим на следующую строку, а не сваливаем всё в одну.
  for (let i = 0; i < s.packages.length; i += 3) {
    for (const p of s.packages.slice(i, i + 3)) kb.text(buyButtonText(p));
    kb.row();
  }
  // 🔴 08.09, живая жалоба (узел #19): «друг не может взять пробный, кнопки просто нет».
  // Раньше кнопка ПРОПАДАЛА у того, кто пробный уже брал — и снаружи это неотличимо от
  // «бот сломан»: человек удаляет чат, жмёт /start заново, кнопки всё нет, и объяснения
  // тоже нет. Теперь кнопка на месте, а `giveTrial` честно отвечает «пробный у тебя уже
  // был» — вопрос закрывается сам, без обращения к владельцу.
  // У владельца её по-прежнему нет намеренно: у него есть своя «🆓 Мой VPN».
  if (s.trial.enabled && userId !== undefined && !owner) {
    kb.text(`🎁 Попробовать бесплатно (${humanHours(s.trial.hours)})`).row();
  }
  if (getSettings().referral.enabled) kb.text('🤝 Пригласить друга').row();
  // Показываем, только если владелец завёл хоть один код: иначе кнопка обещает
  // скидку, которой не существует.
  if (allPromos().length > 0) kb.text('🎟 Промокод').row();
  kb.text('📱 Установить приложение').text('❓ Помощь').row();
  // Промо-кнопка франшизы — reply-панель не умеет URL-кнопки, поэтому это
  // текст-кнопка, по которой бот присылает ссылку на станок (см. hears ниже).
  // Та же защита white-label, что была у inline-версии (branding.ts): у
  // оплативших снятие промо её нет.
  if (promoEnabled()) kb.text('💰 Заработай на своём VPN так же').row();
  if (owner) kb.text('⚙️ Мой бот').row();
  return kb.resized().persistent();
}

// Последнее приветствие в чате — удаляем старое при новом /start (не копим).
const lastMenu = new Map<number, number>();

async function showMenu(ctx: any): Promise<void> {
  const s = getSettings();
  const chatId = ctx.chat.id;
  const prev = lastMenu.get(chatId);
  if (prev) await ctx.api.deleteMessage(chatId, prev).catch(() => {});

  const kb = clientKeyboard(isOwner(ctx.from?.id), ctx.from?.id);
  const text = welcomeText();
  const m = s.welcome.photo
    ? await ctx.replyWithPhoto(s.welcome.photo, { caption: text, reply_markup: kb }).catch(() => null)
    : null;
  const msg = m ?? (await ctx.reply(text, { reply_markup: kb }));
  lastMenu.set(chatId, msg.message_id);
}

bot.command('start', async (ctx) => {
  pending = null;
  claimOwnerIfUnset(ctx.from!.id);
  // Реферальная ссылка вида /start r<id>. Привязка молчаливая, если она уже была —
  // человек не должен видеть «ты приглашён» на каждый /start.
  const inviter = parseCode(ctx.match as string | undefined);
  const me = ctx.from!.id;
  if (inviter !== null && bindReferral(me, inviter, { isOwner: isOwner(me) })) {
    await ctx.reply(
      '👋 Ты пришёл по приглашению. Ничего делать не нужно — просто выбери тариф. ' +
        'Тому, кто тебя позвал, за твою первую покупку добавится время.',
    );
  }
  await showMenu(ctx);
});

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  pending = null;
  await ctx.deleteMessage().catch(() => {});
  await showMenu(ctx);
});

async function sendApps(ctx: any): Promise<void> {
  await ctx.reply(appLinksText(), { link_preview_options: { is_disabled: true } });
}

const HELP_TEXT =
  '❓ Как это работает:\n\n' +
  '1. Выбери срок кнопкой 🛒 и оплати звёздами Telegram.\n' +
  '2. Пришлю ключ — вместе с ним будет кнопка на нужное приложение под этот ключ.\n' +
  '3. Готово, VPN работает. Ключ можно переключать между странами прямо в приложении.\n\n' +
  'Если ключ не пришёл или что-то не так — напиши сюда же, владелец бота поможет.';

async function sendHelp(ctx: any): Promise<void> {
  await ctx.reply(HELP_TEXT, { link_preview_options: { is_disabled: true } });
}

bot.callbackQuery('apps', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendApps(ctx);
});

bot.callbackQuery('cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  pending = null;
  await ctx.editMessageText('Отменено.').catch(() => {});
});

// ── покупка ───────────────────────────────────────────────────────────────
// Промокод едет в payload самого счёта, а не хранится как «активный код человека»:
// перезапуск бота иначе терял бы применённую скидку, и человек платил бы полную цену
// за то, на что ему её пообещали. Старый формат payload (`pkg:<id>`, без кода) обязан
// читаться дальше — счета уже висят у людей в чатах и должны доплачиваться.
async function sendInvoice(
  ctx: any,
  pkg: NonNullable<ReturnType<typeof findPackage>>,
  promoCode?: string,
): Promise<void> {
  const check = promoCode !== undefined ? checkPromo(promoCode, ctx.from?.id ?? 0) : undefined;
  const promo = check?.ok ? check.promo : undefined;
  const stars = promo ? discountedStars(pkg.stars, promo.percent) : pkg.stars;
  await ctx.replyWithInvoice(
    'VPN-доступ',
    promo
      ? `Доступ к VPN на ${pkg.days} дней · промокод ${promo.code} (−${promo.percent}%)`
      : `Доступ к VPN на ${pkg.days} дней`,
    promo ? `pkg:${pkg.id}:${promo.code}` : `pkg:${pkg.id}`,
    'XTR', // Telegram Stars
    [{ label: `VPN ${pkg.days} дн.`, amount: stars }],
  );
  // Оплата картой идёт отдельным сообщением, а не кнопкой на счёте: к счёту Telegram
  // чужие кнопки не приделать. Со скидкой карту не показываем намеренно — цена в Tribute
  // фиксированная, промокод там не сработает, и кнопка обещала бы то, чего не будет.
  const card = promo ? undefined : tributeUrlFor(pkg.id);
  if (card) {
    await ctx.reply(`💳 Или картой${card.label ? ` — ${card.label}` : ''}. Ключ придёт сюда же, автоматически.`, {
      reply_markup: new InlineKeyboard().url('💳 Оплатить картой', card.url),
    });
  }
}

// inline-кнопка покупки остаётся для совместимости (старые сообщения в чатах);
// основной путь теперь — кнопка на панели (см. bot.hears(/^🛒 /) ниже).
bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pkg = findPackage(ctx.match[1]);
  if (!pkg) {
    await ctx.reply('Этот тариф больше не действует — нажми /start и выбери заново.');
    return;
  }
  await sendInvoice(ctx, pkg);
});

bot.callbackQuery(/^buypromo:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pkg = findPackage(ctx.match[1]);
  if (!pkg) {
    await ctx.reply('Этот тариф больше не действует — нажми /start и выбери заново.');
    return;
  }
  await sendInvoice(ctx, pkg, ctx.match[2]);
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

/**
 * Выдача купленного: одна дверь для всех способов оплаты. Звёзды Telegram и карта через
 * Tribute отличаются ровно тем, ЧЕМ заплатили; всё, что происходит после — пиры на всех
 * локациях, запись подписки, бонусные дни, промокод, благодарность пригласившему —
 * обязано быть одинаковым. Разъедутся два пути выдачи — разъедутся и баги в них.
 *
 * chatId равен userId: платящий пишет боту в личку, других чатов у продажи не бывает.
 */
async function deliverPurchase(opts: {
  userId: number;
  username?: string;
  pkg?: ReturnType<typeof findPackage>;
  /** Сколько звёзд заплачено; для карты 0 — сумма живёт в Tribute, а не у нас. */
  stars: number;
  promoCode?: string;
  /** Идентификатор платежа — реферальной программе, чтобы не начислить дважды. */
  charge: string;
  /** Чем заплачено, для сообщения владельцу и лога. */
  method: 'stars' | 'card';
}): Promise<boolean> {
  const { userId, pkg } = opts;
  // Копилка реферальных дней применяется ИМЕННО ЗДЕСЬ, при первой же покупке: выдавать
  // пиры тому, кто сам ничего не покупал, значит раздавать бесплатный VPN за приглашения.
  const bonusDays = takeBanked(userId);
  const days = (pkg?.days ?? config.days) + bonusDays;
  recordEvent({ type: 'paid', stars: opts.stars, userId });
  // Платный тариф даёт доступ ко ВСЕМ локациям — ровно то, о чём просил франчайзи:
  // «покупает на месяц, а ему доступен Лондон, Финляндия».
  const peers = await generateEverywhere(bot.api, userId);
  if (peers.length === 0) return false;
  addSubscription(
    peers.map((p) => ({ loc: p.loc, pubkey: p.pubkey })),
    days,
    { userId, username: opts.username, stars: opts.stars },
  );
  await offerConfigs(bot.api, userId, peers.map((p) => ({ config: p.config, title: p.locTitle, protocol: p.protocol })));
  if (bonusDays > 0) {
    await bot.api.sendMessage(userId, `🤝 К сроку добавлено ${bonusDays} дн. за приглашённых друзей.`).catch(() => {});
  }
  // Списываем промокод ТОЛЬКО после успешной оплаты: списание при вводе позволяло бы
  // любому желающему сжечь лимит чужого кода, ничего не заплатив.
  if (opts.promoCode) markPromoUsed(opts.promoCode, userId);
  void awardReferral(bot.api, userId, pkg?.days ?? config.days, opts.charge);
  return true;
}

bot.on('message:successful_payment', async (ctx) => {
  const pay = ctx.message.successful_payment;
  // payload: `pkg:<id>` (старый формат) либо `pkg:<id>:<ПРОМОКОД>`.
  const [payloadPkg, payloadPromo] = pay.invoice_payload.replace(/^pkg:/, '').split(':');
  await deliverPurchase({
    userId: ctx.from.id,
    username: ctx.from.username,
    pkg: findPackage(payloadPkg),
    stars: pay.total_amount,
    promoCode: payloadPromo,
    charge: pay.telegram_payment_charge_id,
    method: 'stars',
  });
});

/**
 * Начисление пригласившему. Намеренно НЕ ждём результата в обработчике оплаты
 * (`void`) и глушим любую ошибку: упавшая благодарность не должна ломать выдачу
 * уже оплаченного ключа — покупка важнее бонуса.
 *
 * Считаем от КУПЛЕННОГО срока, без бонусных дней: иначе подаренное время само
 * порождало бы новое начисление.
 */
async function awardReferral(api: typeof bot.api, buyer: number, boughtDays: number, charge: string): Promise<void> {
  try {
    const award = registerPurchase(buyer, boughtDays, charge);
    if (!award) return;
    // Продлеваем действующую подписку, а если её нет — кладём в копилку до его
    // собственной первой покупки (пиры за приглашения не выдаём, см. выше).
    const applied = extendForUser(award.inviter, award.days);
    if (!applied) bankDays(award.inviter, award.days);
    await api
      .sendMessage(
        award.inviter,
        applied
          ? `🤝 Друг по твоей ссылке оформил подписку — тебе добавлено ${award.days} дн.`
          : `🤝 Друг по твоей ссылке оформил подписку. Тебе начислено ${award.days} дн. — ` +
              'они добавятся к сроку, как только оформишь подписку.',
      )
      .catch(() => {});
  } catch {
    /* реферальная программа — надстройка, покупку она ронять не должна */
  }
}

// ── пробный период ────────────────────────────────────────────────────────
async function giveTrial(ctx: any): Promise<void> {
  const s = getSettings();
  const userId = ctx.from?.id;
  if (!s.trial.enabled || userId === undefined) return;
  if (hasUsedTrial(userId)) {
    await ctx.reply('Пробный период у тебя уже был — дальше только по подписке.');
    return;
  }
  // Пробный — только основная локация. Это и естественный повод перейти на
  // платный («в подписке доступны все страны»), и меньше мусорных пиров
  // на серверах от тех, кто попробовал и ушёл.
  const peer = await generate(ctx.api, ctx.chat!.id);
  if (!peer) return;
  markTrialUsed(userId);
  recordEvent({ type: 'free', userId });
  addSubscriptionHours([{ loc: peer.loc, pubkey: peer.pubkey }], s.trial.hours, {
    userId,
    username: ctx.from?.username,
    stars: 0,
  });
  await offerConfig(ctx.api, ctx.chat!.id, peer.config, peer.locTitle, peer.protocol);
  await ctx.reply(`🎁 Пробный доступ на ${humanHours(s.trial.hours)} активен. Приложение — кнопка ниже, вместе с ключом.`);
}

bot.callbackQuery('trial', async (ctx) => {
  await ctx.answerCallbackQuery();
  await giveTrial(ctx);
});

// ── кабинет владельца ─────────────────────────────────────────────────────
function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💲 Тарифы', 'tariffs')
    .text('🎁 Пробный период', 'trialcfg')
    .row()
    .text('🔔 Напоминания', 'remcfg')
    .text('🤝 Рефералы', 'refcfg')
    .row()
    .text('🎟 Промокоды', 'promocfg')
    .text('💳 Оплата картой', 'cardcfg')
    .row()
    .text('✍️ Приветствие', 'wtext')
    .text('🖼 Фото', 'wphoto')
    .row()
    .text('👥 Клиенты', 'clients')
    .text('📊 Статистика', 'stats')
    .row()
    .text('🌍 Локации', 'locs')
    .row()
    .text('🆓 Мой VPN', 'free')
    .text('⬆️ Обновление', 'upd')
    .row()
    .text('← В меню', 'menu');
}

function adminText(note?: string): string {
  const s = getSettings();
  return (
    '⚙️ Настройки твоего бота\n\n' +
    `Тарифов: ${s.packages.length}\n` +
    `Пробный период: ${s.trial.enabled ? `включён, ${humanHours(s.trial.hours)}` : 'выключен'}\n` +
    `Приветствие: ${s.welcome.text ? 'своё' : 'стандартное'}${s.welcome.photo ? ' + фото' : ''}\n` +
    `Версия бота: ${currentVersion()}` +
    (note ? `\n\n${note}` : '')
  );
}

async function showAdmin(ctx: any, note?: string): Promise<void> {
  const text = adminText(note);
  await ctx.editMessageText(text, { reply_markup: adminMenu() }).catch(async () => {
    await ctx.reply(text, { reply_markup: adminMenu() });
  });
}

bot.callbackQuery('admin', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  pending = null;
  await showAdmin(ctx);
});

bot.callbackQuery('tariffs', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = getSettings();
  const kb = new InlineKeyboard();
  for (const p of s.packages) kb.text(`✏️ ${packageLabel(p)}`, `pkg:${p.id}`).row();
  if (s.packages.length < LIMITS.MAX_PACKAGES) kb.text('➕ Добавить тариф', 'pkgadd').row();
  kb.text('← Назад', 'admin');
  await ctx
    .editMessageText('💲 Тарифы. Нажми на тариф, чтобы изменить цену или срок.', { reply_markup: kb })
    .catch(() => {});
});

bot.callbackQuery(/^pkg:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const p = findPackage(ctx.match[1]);
  if (!p) return;
  const kb = new InlineKeyboard()
    .text('💲 Цена', `pkgprice:${p.id}`)
    .text('📅 Срок', `pkgdays:${p.id}`)
    .row()
    .text('🗑 Удалить', `pkgdel:${p.id}`)
    .text('← Назад', 'tariffs');
  await ctx.editMessageText(`Тариф: ${packageLabel(p)}`, { reply_markup: kb }).catch(() => {});
});

bot.callbackQuery(/^pkgprice:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const p = findPackage(ctx.match[1]);
  if (!p) return;
  await ctx.reply(`Пришли новую цену в звёздах за ${p.days} дн. Сейчас: ${p.stars} ⭐`, {
    reply_markup: ask('pkg-price', p.id),
  });
});

bot.callbackQuery(/^pkgdays:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const p = findPackage(ctx.match[1]);
  if (!p) return;
  await ctx.reply(`Пришли новый срок в днях. Сейчас: ${p.days}`, { reply_markup: ask('pkg-days', p.id) });
});

bot.callbackQuery(/^pkgdel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const id = ctx.match[1];
  const s = getSettings();
  if (s.packages.length <= 1) {
    await ctx.reply('Последний тариф удалить нельзя — иначе продавать будет нечего.');
    return;
  }
  updateSettings((cur) => ({ ...cur, packages: cur.packages.filter((p) => p.id !== id) }));
  await showAdmin(ctx, '🗑 Тариф удалён.');
});

bot.callbackQuery('pkgadd', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  if (getSettings().packages.length >= LIMITS.MAX_PACKAGES) return;
  await ctx.reply('Новый тариф. Пришли срок в днях (например 180):', { reply_markup: ask('pkg-new-days') });
});

bot.callbackQuery('trialcfg', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = getSettings();
  const kb = new InlineKeyboard()
    .text(s.trial.enabled ? '🔴 Выключить' : '🟢 Включить', 'trialtoggle')
    .text('⏱ Сколько часов', 'trialhours')
    .row()
    .text('← Назад', 'admin');
  await ctx
    .editMessageText(
      `🎁 Пробный период\n\nСейчас: ${s.trial.enabled ? `включён, ${humanHours(s.trial.hours)}` : 'выключен'}\n` +
        `Выдан: ${trialCount()} раз(а). Один человек — один раз.`,
      { reply_markup: kb },
    )
    .catch(() => {});
});

// Напоминания об окончании подписки — настройка владельца.
// Дни переключаются по кругу (1→2→3), а не вводом с клавиатуры: вариантов всего три,
// и лишний шаг «пришли число» тут только мешает.
// Реферальная программа — настройка владельца. Выключена по умолчанию: она раздаёт
// время за его счёт, включать за него нельзя.
bot.callbackQuery('promocfg', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const list = allPromos();
  const kb = new InlineKeyboard();
  for (const pr of list) {
    const used = pr.maxUses !== undefined ? `${pr.usedBy.length}/${pr.maxUses}` : String(pr.usedBy.length);
    kb.text(`🗑 ${pr.code} −${pr.percent}% (${used})`, `promodel:${pr.code}`).row();
  }
  if (list.length < PROMO_LIMITS.MAX_PROMOS) kb.text('➕ Добавить промокод', 'promoadd').row();
  kb.text('← Назад', 'admin');
  await ctx
    .editMessageText(
      '🎟 Промокоды\n\n' +
        (list.length === 0
          ? 'Пока ни одного. Промокод даёт скидку в процентах от цены тарифа.'
          : 'Кнопка удаляет код. В скобках — сколько раз им воспользовались.') +
        '\n\nОдин человек может использовать один код только раз, и списывается он ' +
        'только после оплаты.',
      { reply_markup: kb },
    )
    .catch(() => {});
});

bot.callbackQuery(/^promodel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  removePromo(ctx.match[1]);
  await showAdmin(ctx, `🗑 Промокод ${ctx.match[1]} удалён.`);
});

bot.callbackQuery('promoadd', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(
    'Пришли промокод одной строкой: КОД ПРОЦЕНТ [сколько раз можно использовать]\n\n' +
      'Например:\n' +
      'LETO 20 — код LETO даёт 20% скидки, без ограничения по количеству\n' +
      'FRIEND 50 10 — 50% скидки, но только первым 10 покупателям',
    { reply_markup: ask('promo-add') },
  );
});

bot.callbackQuery('refcfg', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const r = getSettings().referral;
  const kb = new InlineKeyboard()
    .text(r.enabled ? '🔴 Выключить' : '🟢 Включить', 'reftoggle')
    .text(`% Доля (${r.percent}%)`, 'refpercent')
    .row()
    .text('← Назад', 'admin');
  await ctx
    .editMessageText(
      '🤝 Реферальная программа\n\n' +
        `Сейчас: ${r.enabled ? `включена, ${r.percent}% срока` : 'выключена'}\n\n` +
        'Клиент приводит друга по своей ссылке и получает долю от срока, который друг купил — ' +
        'временем, а не деньгами. Считается только первая покупка друга.',
      { reply_markup: kb },
    )
    .catch(() => {});
});

bot.callbackQuery('reftoggle', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = updateSettings((cur) => ({ ...cur, referral: { ...cur.referral, enabled: !cur.referral.enabled } }));
  await showAdmin(ctx, s.referral.enabled ? '🟢 Реферальная программа включена.' : '🔴 Реферальная программа выключена.');
});

bot.callbackQuery('refpercent', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply('Какую долю от срока друга начислять? Пришли число от 1 до 50 (процентов):', {
    reply_markup: ask('ref-percent'),
  });
});

bot.callbackQuery('remcfg', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = getSettings();
  const kb = new InlineKeyboard()
    .text(s.reminder.enabled ? '🔴 Выключить' : '🟢 Включить', 'remtoggle')
    .text(`📅 За ${s.reminder.days} дн.`, 'remdays')
    .row()
    .text('← Назад', 'admin');
  await ctx
    .editMessageText(
      `🔔 Напоминания об окончании

` +
        `Сейчас: ${s.reminder.enabled ? `включены, за ${s.reminder.days} дн. до конца` : 'выключены'}

` +
        `Клиент получит сообщение с кнопками продления до того, как ключ перестанет работать.`,
      { reply_markup: kb },
    )
    .catch(() => {});
});

bot.callbackQuery('remtoggle', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = updateSettings((cur) => ({ ...cur, reminder: { ...cur.reminder, enabled: !cur.reminder.enabled } }));
  await showAdmin(ctx, s.reminder.enabled ? '🟢 Напоминания включены.' : '🔴 Напоминания выключены.');
});

bot.callbackQuery('remdays', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = updateSettings((cur) => {
    const i = REMINDER_DAYS.indexOf(cur.reminder.days);
    const next = REMINDER_DAYS[(i + 1) % REMINDER_DAYS.length];
    return { ...cur, reminder: { ...cur.reminder, days: next } };
  });
  await showAdmin(ctx, `📅 Напоминание за ${s.reminder.days} дн. до окончания.`);
});

bot.callbackQuery('trialtoggle', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = updateSettings((cur) => ({ ...cur, trial: { ...cur.trial, enabled: !cur.trial.enabled } }));
  await showAdmin(ctx, s.trial.enabled ? '🟢 Пробный период включён.' : '🔴 Пробный период выключен.');
});

// Спрашиваем в часах, а не в днях: срок бывает короче суток («дам на 6 часов
// посмотреть»), и владельцу проще написать одно число, чем выбирать единицу.
bot.callbackQuery('trialhours', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(
    `Сколько часов давать бесплатно? Напиши число: 24 — сутки, 72 — трое суток, 6 — шесть часов.
` +
      `Сейчас: ${humanHours(getSettings().trial.hours)}`,
    { reply_markup: ask('trial-hours') },
  );
});

bot.callbackQuery('wtext', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(
    'Пришли текст приветствия — его увидят все, кто нажмёт /start.\n' +
      'Чтобы вернуть стандартный, пришли: сброс',
    { reply_markup: ask('welcome-text') },
  );
});

bot.callbackQuery('wphoto', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply('Пришли фото — оно будет показываться над приветствием.\nУбрать фото: пришли слово «сброс»', {
    reply_markup: ask('welcome-photo'),
  });
});

bot.callbackQuery('clients', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const rows = activeClients();
  const money = revenueStars();
  const head =
    `👥 Клиенты\n\nАктивных подписок: ${rows.length}\n` +
    `Заработано всего: ${money.total} ⭐ (в действующих: ${money.active} ⭐)\n\n`;
  const list =
    rows.length === 0
      ? 'Пока никто не купил.'
      : rows
          .slice(0, 40)
          .map(
            (r) =>
              `• ${r.who} — осталось ${r.hoursLeft < 24 ? `${r.hoursLeft} ч.` : `${r.daysLeft} дн.`}${r.stars ? ` · ${r.stars} ⭐` : ' · пробный'}` +
              (r.locations > 1 ? ` · ${r.locations} локации` : ''),
          )
          .join('\n');
  await ctx
    .editMessageText(head + list, { reply_markup: new InlineKeyboard().text('← Назад', 'admin') })
    .catch(() => {});
});

// ── локации (несколько стран у одного бота) ───────────────────────────────
//
// Флоу добавления: адрес → пароль → бот заходит, ставит себе ключ, забывает
// пароль → название. Пароль спрашивается ровно один раз и на диск не попадает
// (см. attachServer в ssh.ts и saveKey в locations.ts).
async function showLocations(ctx: any, note?: string): Promise<void> {
  const locs = allLocations();
  const kb = new InlineKeyboard();
  for (const l of locs) {
    kb.text(`${l.kind === 'local' ? '🏠' : '🌍'} ${l.title}`, `loc:${l.id}`).row();
  }
  if (remoteCount() < LOCATION_LIMITS.MAX_REMOTE) kb.text('➕ Добавить сервер', 'locadd').row();
  kb.text('← Назад', 'admin');

  const text =
    '🌍 Локации — серверы, с которых выдаются ключи.\n\n' +
    `Сейчас: ${locs.length}. Клиент при покупке получает ключ на КАЖДУЮ — ` +
    'если одна страна ляжет, он переключится на другую прямо в приложении.\n\n' +
    (locs.length === 1
      ? '💡 Пока сервер один. Добавь второй — это заметное преимущество перед конкурентами, ' +
        'и за него можно брать дороже.'
      : 'Нажми на локацию, чтобы переименовать или убрать.') +
    (note ? `\n\n${note}` : '');
  await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
    await ctx.reply(text, { reply_markup: kb });
  });
}

bot.callbackQuery('locs', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  pending = null;
  await showLocations(ctx);
});

bot.callbackQuery('locadd', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  if (remoteCount() >= LOCATION_LIMITS.MAX_REMOTE) return;
  await ctx.reply(
    '➕ Новый сервер.\n\n' +
      'Пришли его IP-адрес.\n\n' +
      'Если SSH у тебя не на стандартном порту — через двоеточие: 203.0.113.10:2222\n\n' +
      '✅ Подойдёт даже чистый VPS: если VPN на нём ещё нет — я поставлю его сам.',
    { reply_markup: ask('loc-host'), link_preview_options: { is_disabled: true } },
  );
});

bot.callbackQuery(/^loc:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const loc = findLocation(ctx.match[1]);
  if (!loc) return;
  const kb = new InlineKeyboard().text('✏️ Переименовать', `locren:${loc.id}`);
  if (loc.kind !== 'local') {
    kb.text('🌐 Сменить IP', `locip:${loc.id}`).row();
    kb.text('🗑 Убрать', `locdel:${loc.id}`);
  }
  kb.row().text('← Назад', 'locs');

  let status = 'это сервер, на котором работает сам бот';
  if (loc.kind === 'ssh') {
    status = (await ping(loc.remote!)) ? '🟢 на связи' : '🔴 не отвечает';
  }
  await ctx
    .editMessageText(`${loc.title}\n\n${loc.kind === 'ssh' ? `Адрес: ${loc.remote!.host}${loc.remote!.port ? ':' + loc.remote!.port : ''}\n` : ''}Статус: ${status}`, {
      reply_markup: kb,
    })
    .catch(() => {});
});

bot.callbackQuery(/^locren:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const loc = findLocation(ctx.match[1]);
  if (!loc) return;
  await ctx.reply(`Пришли новое название для «${loc.title}». Его увидят клиенты — пиши страну или город.`, {
    reply_markup: ask('loc-rename', loc.id),
  });
});

bot.callbackQuery(/^locip:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const loc = findLocation(ctx.match[1]);
  if (!loc || loc.kind !== 'ssh') return;
  await ctx.reply(
    `🌐 Новый адрес для «${loc.title}».\n\n` +
      `Сейчас: ${loc.remote!.host}${loc.remote!.port ? ':' + loc.remote!.port : ''}\n\n` +
      'Пришли новый IP (или IP:порт, если SSH не на 22). Ключ доступа сохранится — ' +
      'если это та же машина с новым IP, всё продолжит работать, и новые конфиги сразу ' +
      'пойдут с правильным адресом.',
    { reply_markup: ask('loc-editip', loc.id) },
  );
});

bot.callbackQuery(/^locdel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const id = ctx.match[1];
  if (id === PRIMARY_LOCATION_ID) return; // основную убрать нельзя — бот на ней и живёт
  const ok = removeRemote(id);
  await showLocations(ctx, ok ? '🗑 Локация убрана. Новые ключи на неё выдаваться не будут.' : 'Не нашёл такую.');
});

bot.callbackQuery('stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx
    .editMessageText(await buildStats(), { reply_markup: new InlineKeyboard().text('← Назад', 'admin') })
    .catch(() => {});
});

bot.callbackQuery('upd', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const { local, remote, available } = await checkUpdate();
  const kb = new InlineKeyboard();
  if (available) kb.text('⬆️ Обновить сейчас', 'updgo').row();
  kb.text('← Назад', 'admin');
  await ctx
    .editMessageText(
      available
        ? `Твоя версия: ${local}\nДоступна: ${remote}\n\nОбновление занимает пару минут, бот на это время перезапустится. Клиенты и подписки не пострадают.`
        : `Твоя версия: ${local}${remote ? `\nПоследняя: ${remote}` : ''}\n\nОбновлений нет.`,
      { reply_markup: kb },
    )
    .catch(() => {});
});

bot.callbackQuery('updgo', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.editMessageText('⏳ Обновляюсь… Через пару минут напиши /start — я вернусь уже новым.').catch(() => {});
  startSelfUpdate();
});

// Владелец берёт бесплатный доступ — по конфигу на КАЖДУЮ локацию (не только
// primary), постоянному, без новых пиров на каждый клик.
//
// 🔴 Фикс 26.08: раньше это жёстко звало createVpnPeer() без аргумента —
// та всегда возвращает primary (см. vpn.ts::createVpnPeer, «совместимость
// со старым вызовом»). Владелец физически не мог получить через «Мой VPN»
// ни одной доп. локации, даже рабочей — только вечно один и тот же primary,
// закешированный в единственном файле. Поймано на живом узле (Александр,
// пытался проверить «Амстердам», кнопка молча подсовывала primary).
bot.callbackQuery('free', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const chatId = ctx.chat!.id;

  const toSend: { config: string; title: string; protocol: VpnProtocol }[] = [];
  const failed: { title: string; reason: string }[] = [];
  for (const loc of allLocations()) {
    const existing = readOwnerConfig(loc.id, loc.protocol);
    if (existing) {
      toSend.push({ config: existing, title: loc.title, protocol: loc.protocol });
      continue;
    }
    try {
      const peer = await createVpnPeerAt(loc);
      saveOwnerConfig(loc.id, peer.config, peer.protocol);
      toSend.push({ config: peer.config, title: peer.locTitle, protocol: peer.protocol });
    } catch (e) {
      failed.push({ title: loc.title, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (toSend.length === 0) return;
  recordEvent({ type: 'free', userId: getOwnerId() });
  await offerConfigs(ctx.api, chatId, toSend);
  if (failed.length > 0) {
    await ctx.reply(
      '⚠️ Не выдал конфиг для: ' + failed.map((f) => `${f.title} (${f.reason})`).join(', '),
    );
  }
});

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(await buildStats());
});

// ── нажатия панели кнопок (reply-клавиатура) ──────────────────────────────
// Регистрируются ДО обработчика ввода владельца ниже: bot.hears терминален,
// поэтому нажатие панели не «съедается» ожиданием ввода. Клиентские кнопки
// НЕ трогают pending (это глобальное состояние ввода ВЛАДЕЛЬЦА — обнулять его
// нажатием клиента нельзя); pending чистит только вход в кабинет владельца.
bot.hears('🎟 Промокод', async (ctx) => {
  if (allPromos().length === 0) return;
  awaitingPromo.set(ctx.from!.id, Date.now());
  await ctx.reply('🎟 Пришли промокод одним сообщением.');
});

bot.hears('🤝 Пригласить друга', async (ctx) => {
  const s = getSettings();
  if (!s.referral.enabled) return;
  const me = ctx.from!.id;
  const st = statsFor(me);
  const lines = [
    `🤝 Приведи друга — получи ${s.referral.percent}% его срока временем.`,
    '',
    'Твоя ссылка (перешли её другу):',
    inviteLink(bot.botInfo.username, me),
    '',
    'Как это работает:',
    '• друг переходит по ссылке и оформляет подписку;',
    `• тебе добавляется ${s.referral.percent}% от срока, который он купил;`,
    '• считается от первой покупки друга, время приходит само.',
  ];
  if (st.invited > 0 || st.daysEarned > 0) {
    lines.push('', `Пришло по ссылке: ${st.invited} · купили: ${st.bought} · начислено: ${st.daysEarned} дн.`);
  }
  // Копилка: дни есть, но применить их пока некуда — честно про это говорим,
  // иначе человек считает, что бонус потерялся.
  if (st.banked > 0) lines.push('', `⏳ Ждут твоей первой подписки: ${st.banked} дн.`);
  await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
});

bot.hears('📱 Установить приложение', (ctx) => sendApps(ctx));
bot.hears('❓ Помощь', (ctx) => sendHelp(ctx));

bot.hears('💰 Заработай на своём VPN так же', async (ctx) => {
  if (!promoEnabled()) return; // white-label: у оплативших промо нет
  await ctx.reply(`💰 Свой такой же VPN-бот и заработок на нём — здесь:\n${config.stanokUrl}`, {
    link_preview_options: { is_disabled: true },
  });
});

bot.hears('⚙️ Мой бот', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  pending = null;
  await ctx.reply(adminText(), { reply_markup: adminMenu() });
});

bot.hears(/^🎁 /, async (ctx) => {
  await giveTrial(ctx);
});

bot.hears(/^🛒 /, async (ctx) => {
  // Тариф ищем по точному тексту кнопки на текущий момент: цены/сроки могли
  // измениться (владелец правил), тогда старая надпись не найдётся — покажем
  // свежее меню, а не выставим неверный счёт.
  const text = ctx.message?.text;
  const pkg = text ? getSettings().packages.find((p) => buyButtonText(p) === text) : undefined;
  if (!pkg) {
    await showMenu(ctx);
    return;
  }
  await sendInvoice(ctx, pkg);
});

// ── ввод владельца (текст и фото) ─────────────────────────────────────────
bot.on('message:photo', async (ctx) => {
  if (!pending || pending.kind !== 'welcome-photo' || !isOwner(ctx.from?.id)) return;
  if (expired()) {
    pending = null;
    return;
  }
  const fileId = ctx.message.photo.at(-1)?.file_id;
  if (!fileId) return;
  pending = null;
  updateSettings((cur) => ({ ...cur, welcome: { ...cur.welcome, photo: fileId } }));
  await ctx.reply('✅ Фото приветствия обновлено. Проверь: /start');
});

bot.on('message:text', async (ctx) => {
  // Ввод промокода клиентом идёт первым: обработчик владельца ниже обрывает цепочку,
  // и до отдельного хендлера сообщение бы уже не дошло.
  const promoWaiter = awaitingPromo.get(ctx.from?.id ?? 0);
  if (promoWaiter !== undefined) {
    if (Date.now() - promoWaiter > PROMPT_TTL_MS) {
      awaitingPromo.delete(ctx.from!.id);
    } else {
      const code = ctx.message.text.trim();
      const res = checkPromo(code, ctx.from!.id);
      if (!res.ok) {
        const why =
          res.reason === 'used'
            ? 'Этот промокод ты уже использовал.'
            : res.reason === 'exhausted'
              ? 'Этот промокод уже исчерпан.'
              : 'Такого промокода нет — проверь написание.';
        await ctx.reply(`❌ ${why}`);
        return;
      }
      awaitingPromo.delete(ctx.from!.id);
      const kb = new InlineKeyboard();
      for (const pk of getSettings().packages) {
        kb.text(`${pk.days} дн · ${discountedStars(pk.stars, res.promo.percent)}⭐`, `buypromo:${pk.id}:${res.promo.code}`).row();
      }
      await ctx.reply(`✅ Промокод ${res.promo.code} принят: −${res.promo.percent}%. Выбери срок:`, { reply_markup: kb });
      return;
    }
  }
  if (!pending || !isOwner(ctx.from?.id)) return;
  if (expired()) {
    pending = null;
    return;
  }
  const text = ctx.message.text.trim();
  const n = Number(text);
  const { kind, arg } = pending;

  if (kind === 'tribute-key') {
    pending = null;
    // Удаляем сообщение с ключом сразу: чат владельца с ботом — не хранилище секретов,
    // а ключ Tribute даёт доступ к его кассе. Не вышло удалить — честно скажем, чтобы он
    // убрал сам, а не думал, что всё чисто.
    const wiped = await ctx.deleteMessage().then(() => true).catch(() => false);

    const input = classifyKeyInput(text);
    const key = input.key;

    // Самые частые «не то»: вместо ключа присылают ссылку на товар или токен бота.
    // Молча отвергнуть — значит оставить человека гадать, что он сделал не так.
    if (input.kind === 'link') {
      logSetup('key-link');
      await ctx.reply(
        '❌ Это ссылка на товар, а не ключ. Ссылки присылать не нужно — бот берёт их сам.\n\n' +
          'Ключ лежит в кабинете Tribute: их бот → «…» → Настройки → API-ключи. Это длинная строка ' +
          'из букв и цифр через дефисы.',
      );
      return;
    }
    if (input.kind === 'bot-token') {
      logSetup('key-bot-token');
      await ctx.reply('❌ Это токен бота из BotFather, а не ключ Tribute. Нужен ключ из кабинета Tribute → Настройки → API-ключи.');
      return;
    }
    if (input.kind === 'short') {
      logSetup('key-short', `длина ${key.length}`);
      await ctx.reply('❌ Слишком короткая строка для ключа — похоже, скопировалась не целиком. Скопируй ключ полностью и пришли снова.');
      return;
    }

    const v = await verifyTributeKey(key);
    if (!v.ok) {
      // Ключ не сохраняем, пока он не доказал работоспособность: сохранённый нерабочий
      // выглядит как «подключено», а оплата при этом не придёт вообще. И «не тот ключ»
      // отделено от «не смог проверить» — это разные беды с разными действиями.
      logSetup(v.reason === 'invalid' ? 'key-invalid' : 'key-network', v.detail);
      await ctx.reply(
        v.reason === 'invalid'
          ? '❌ Tribute не принял этот ключ. Проверь, что копируешь его целиком и из своего кабинета.'
          : `⚠️ Не смог проверить ключ (${v.detail}). Это не значит, что ключ плохой — попробуй ещё раз через минуту.`,
      );
      return;
    }

    updateSettings((cur) => ({ ...cur, tribute: { ...cur.tribute, apiKey: key } }));
    logSetup('key-ok', `товаров ${v.rows.length}`);
    productCache = { at: Date.now(), rows: v.rows };
    syncTributeServer();
    if (v.rows.length === 0) {
      await ctx.reply(
        '✅ Ключ принят, но товаров в твоём Tribute пока нет.' + '\n\n' +
          'Заведи товары там (по одному на каждый срок), потом вернись сюда и нажми «Привязать тарифы».' +
          (wiped ? '' : '\n\n' + 'Сообщение с ключом удали сам — у меня не хватило прав.'),
      );
      return;
    }
    const url = webhookUrl();
    await ctx.reply(
      `✅ Ключ принят, товаров в Tribute: ${v.rows.length}.` +
        (wiped ? '' : ' Сообщение с ключом удали сам — у меня не хватило прав.') +
        (url ? '\n\n' + 'Теперь вставь этот адрес в кабинете Tribute (Настройки → API-ключи):' + '\n' + `<code>${url}</code>` : '') +
        '\n\n' + 'Дальше: «⚙️ Мой бот» → «💳 Оплата картой» → «Привязать тарифы».',
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (kind === 'welcome-text') {
    pending = null;
    const reset = text.toLowerCase() === 'сброс';
    updateSettings((cur) => ({
      ...cur,
      welcome: { ...cur.welcome, text: reset ? null : text.slice(0, LIMITS.MAX_WELCOME_LEN) },
    }));
    await ctx.reply(reset ? '✅ Вернул стандартное приветствие.' : '✅ Приветствие обновлено. Проверь: /start');
    return;
  }

  if (kind === 'welcome-photo') {
    if (text.toLowerCase() !== 'сброс') {
      await ctx.reply('Пришли именно фото, либо слово «сброс».');
      return;
    }
    pending = null;
    updateSettings((cur) => ({ ...cur, welcome: { ...cur.welcome, photo: null } }));
    await ctx.reply('✅ Фото убрано.');
    return;
  }

  // ── добавление локации ──────────────────────────────────────────────────
  if (kind === 'loc-host') {
    const addr = parseHostPort(text);
    if (!addr) {
      await ctx.reply(
        '❌ Это не похоже на адрес сервера. Пришли IP или домен, например 203.0.113.10 ' +
          '(или 203.0.113.10:2222, если SSH на другом порту).',
      );
      return;
    }
    // Дальше несём адрес одной строкой — порт восстанавливаем тем же разбором.
    const addrText = addr.port ? `${addr.host}:${addr.port}` : addr.host;
    await ctx.reply(
      'Теперь пришли root-пароль от этого сервера.\n\n' +
        '🔒 Он нужен ровно один раз: я зайду, поставлю себе отдельный ключ доступа и пароль забуду — ' +
        'нигде не сохраняю. Можешь сменить его сразу после, ничего не сломается.',
      { reply_markup: ask('loc-password', addrText) },
    );
    return;
  }

  if (kind === 'loc-password') {
    const { host, port } = parseHostPort(arg!)!;
    const password = text;
    pending = null;
    // Пароль в чате — сразу удаляем сообщение: он не должен остаться в истории
    // ни у него, ни на серверах телеграма дольше необходимого.
    await ctx.deleteMessage().catch(() => {});
    const wait = await ctx.reply('⏳ Подключаюсь к серверу…');
    const editWait = (t: string) =>
      ctx.api
        .editMessageText(ctx.chat.id, wait.message_id, t, { link_preview_options: { is_disabled: true } })
        .then(() => {})
        .catch(() => {});
    try {
      // Если VPN на сервере нет — attachServer поставит его сам (сообщит через editWait).
      const { privateKey, installedNow } = await attachServer(host, 'root', password, port ?? 22, editWait);
      const id = nextLocationId();
      const keyFile = `loc-${id}.key`;
      saveKey(keyFile, privateKey);
      addRemote({ id, title: host, host, ...(port ? { port } : {}), user: 'root', keyFile });
      await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      const vpnLine = installedNow ? '\n🛡 VPN на нём я поставил сам — сервер сразу готов выдавать ключи.' : '';
      await ctx.reply(
        `✅ Сервер ${host} подключён.${vpnLine}\n\nКак назвать эту локацию? Название увидят клиенты — ` +
          'пришли страну или город, например «Лондон».',
        { reply_markup: ask('loc-title', id) },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await editWait('❌ Не получилось подключиться.\n\nТех. детали:\n' + msg);
    }
    return;
  }

  if (kind === 'loc-title' || kind === 'loc-rename') {
    pending = null;
    renameLocation(arg!, text);
    await ctx.reply(`✅ Локация теперь называется «${text.trim().slice(0, LOCATION_LIMITS.MAX_TITLE_LEN)}».`);
    return;
  }

  if (kind === 'loc-editip') {
    const parsed = parseHostPort(text);
    if (!parsed) {
      await ctx.reply('❌ Это не похоже на адрес. Пришли IP или IP:порт, например 203.0.113.10 или 203.0.113.10:2222.');
      return;
    }
    const loc = findLocation(arg!);
    if (!loc || loc.kind !== 'ssh') {
      pending = null;
      await ctx.reply('Локация не найдена.');
      return;
    }
    pending = null;
    const wait = await ctx.reply('⏳ Проверяю доступ по новому адресу…');
    // Пингуем НОВЫЙ адрес СТАРЫМ ключом: если это та же машина с новым IP,
    // ключ в её authorized_keys сохранился и доступ есть — тогда меняем адрес.
    // Если ключ не подошёл, это, вероятно, другой сервер — обновлять адрес на
    // недоступный нельзя, честнее попросить пере-добавить с паролем.
    const probe = { ...loc.remote!, host: parsed.host, port: parsed.port };
    const alive = await ping(probe);
    if (!alive) {
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          wait.message_id,
          `❌ По адресу ${parsed.host} сервер не отвечает нашим ключом.\n\n` +
            'Если это ТА ЖЕ машина с новым IP — проверь, что сервер включён и IP верный, и попробуй снова.\n' +
            'Если это ДРУГОЙ сервер — убери эту локацию и добавь заново (нужен root-пароль, чтобы поставить ключ).',
        )
        .catch(() => {});
      return;
    }
    updateRemoteHost(loc.id, parsed.host, parsed.port);
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        wait.message_id,
        `✅ Адрес обновлён: ${parsed.host}${parsed.port ? ':' + parsed.port : ''}. Сервер отвечает.\n\n` +
          'Новые конфиги пойдут уже с этим адресом. Старые (со старым IP) не оживут — выдай клиентам свежие.',
      )
      .catch(() => {});
    return;
  }

  if (kind === 'pkg-price' || kind === 'pkg-new-stars') {
    if (!isValidStars(n)) {
      await ctx.reply(`❌ Нужно целое число от 1 до ${LIMITS.MAX_STARS}.`);
      return;
    }
    if (kind === 'pkg-price') {
      updateSettings((cur) => ({
        ...cur,
        packages: cur.packages.map((p) => (p.id === arg ? { ...p, stars: n } : p)),
      }));
      pending = null;
      await ctx.reply(`✅ Цена обновлена: ${n} ⭐`);
    } else {
      const days = Number(arg);
      updateSettings((cur) => ({
        ...cur,
        packages: [...cur.packages, { id: nextPackageId(), days, stars: n }],
      }));
      pending = null;
      await ctx.reply(`✅ Тариф добавлен: ${days} дн. — ${n} ⭐`);
    }
    return;
  }

  if (kind === 'promo-add') {
    const [rawCode, rawPercent, rawMax] = text.split(/\s+/);
    const percent = Number(rawPercent);
    const maxUses = rawMax === undefined ? undefined : Number(rawMax);
    if (!rawCode || !isValidCode(rawCode)) {
      await ctx.reply('❌ Код: 3–24 символа, латиница, цифры, дефис или подчёркивание. Пришли ещё раз:');
      return;
    }
    if (!isValidPromoPercent(percent)) {
      await ctx.reply(`❌ Процент — целое число от ${PROMO_LIMITS.MIN_PERCENT} до ${PROMO_LIMITS.MAX_PERCENT}. Пришли ещё раз:`);
      return;
    }
    if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1)) {
      await ctx.reply('❌ Количество использований — целое число от 1. Пришли ещё раз:');
      return;
    }
    if (!addPromo(rawCode, percent, maxUses)) {
      await ctx.reply('❌ Такой код уже есть, либо достигнут предел количества кодов.');
      return;
    }
    pending = null;
    await ctx.reply(
      `✅ Промокод ${rawCode.toUpperCase()} создан: −${percent}%` +
        (maxUses !== undefined ? `, на ${maxUses} использований.` : ', без ограничения.'),
    );
    return;
  }

  if (kind === 'ref-percent') {
    if (!isValidPercent(n)) {
      await ctx.reply('❌ Нужно целое число от 1 до 50. Больше половины срока — это уже не программа лояльности.');
      return;
    }
    updateSettings((cur) => ({ ...cur, referral: { ...cur.referral, percent: n } }));
    pending = null;
    await ctx.reply(`✅ Доля друга: ${n}% от купленного срока.`);
    return;
  }

  if (kind === 'trial-hours') {
    if (!isValidHours(n)) {
      await ctx.reply(`❌ Нужно целое число часов от 1 до ${LIMITS.MAX_DAYS * 24}. Например 24 — это сутки.`);
      return;
    }
    updateSettings((cur) => ({ ...cur, trial: { ...cur.trial, hours: n } }));
    pending = null;
    await ctx.reply(`✅ Пробный период: ${humanHours(n)}${n % 24 === 0 ? '' : ` (${n} ч.)`}`);
    return;
  }

  if (kind === 'pkg-days' || kind === 'pkg-new-days') {
    if (!isValidDays(n)) {
      await ctx.reply(`❌ Нужно целое число дней от 1 до ${LIMITS.MAX_DAYS}.`);
      return;
    }
    if (kind === 'pkg-days') {
      updateSettings((cur) => ({
        ...cur,
        packages: cur.packages.map((p) => (p.id === arg ? { ...p, days: n } : p)),
      }));
      pending = null;
      await ctx.reply(`✅ Срок обновлён: ${n} дн.`);
    } else {
      await ctx.reply(`Теперь пришли цену в звёздах за ${n} дн.:`, { reply_markup: ask('pkg-new-stars', String(n)) });
    }
    return;
  }
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

/**
 * Выдача на всех локациях сразу — для платных тарифов.
 *
 * 🔴 Частичный успех считается успехом: человек уже заплатил. Если из трёх
 * стран поднялись две — отдаём две и честно говорим про третью. Уронить всю
 * покупку из-за одного лежащего сервера было бы худшим из возможных исходов,
 * тем более что фича затевалась ровно про «сервера в одной стране легли».
 * Владельцу о падении сообщаем отдельно — он должен узнать раньше клиентов.
 */
async function generateEverywhere(api: typeof bot.api, chatId: number): Promise<Peer[]> {
  const wait = await api.sendMessage(chatId, '⏳ Генерирую VPN…');
  const { peers, failed } = await createVpnPeersEverywhere();
  await api.deleteMessage(chatId, wait.message_id).catch(() => {});

  if (failed.length > 0) {
    const ownerId = getOwnerId();
    if (ownerId) {
      await api
        .sendMessage(
          ownerId,
          '⚠️ При выдаче ключа не ответили серверы:\n' +
            failed.map((f) => `• ${f.title}: ${f.reason}`).join('\n') +
            '\n\nКлиент получил доступ к остальным. Проверь эти узлы.',
        )
        .catch(() => {});
    }
  }

  if (peers.length === 0) {
    await api
      .sendMessage(
        chatId,
        '❌ Не получилось выдать VPN — ни один сервер не ответил.\n\n' +
          'Деньги не потеряны: напиши владельцу бота, он разберётся и выдаст ключ вручную.',
      )
      .catch(() => {});
    return [];
  }

  if (failed.length > 0) {
    await api
      .sendMessage(
        chatId,
        `⚠️ Одна из локаций сейчас недоступна (${failed.map((f) => f.title).join(', ')}) — ` +
          'выдал ключи на остальные. Как только починим, напишу и пришлю недостающие.',
      )
      .catch(() => {});
  }
  return peers;
}

// Раз в час отзываем истёкшие подписки (удаляем пиры с серверов).
// У одной подписки теперь может быть несколько ключей на разных локациях —
// отзываем каждый там, где он выдан, и по одному. Упавший сервер не должен
// мешать отозвать ключи на остальных: иначе один лежащий узел оставил бы
// бесплатный доступ на всех прочих.
async function sweepExpired(): Promise<void> {
  for (const peer of getExpiredPeers()) {
    try {
      await revokePeerAt(peer.loc, peer.pubkey);
      removePeer(peer.pubkey); // убираем из хранилища только после успешного отзыва
      console.log('Отозван истёкший ключ:', peer.pubkey, 'на', peer.loc);
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

// Напоминания об окончании подписки. Раз в час, тем же ритмом, что и отзыв истёкших:
// точность до часа тут достаточная, а отдельный таймер только плодил бы сущности.
//
// Помечаем отправленным ДАЖЕ при ошибке отправки: самая частая причина — человек
// заблокировал бота, и повторять ему каждый час бессмысленно. Один срок — одно
// напоминание, что бы ни случилось.
async function sweepReminders(): Promise<void> {
  const s = getSettings();
  if (!s.reminder.enabled) return;
  for (const r of pendingReminders(s.reminder.days)) {
    const when =
      r.hoursLeft < 24
        ? r.hoursLeft <= 1
          ? 'меньше чем через час'
          : `через ${r.hoursLeft} ч.`
        : r.daysLeft === 1
          ? 'завтра'
          : `через ${r.daysLeft} дн.`;
    const kb = new InlineKeyboard();
    for (const p of getSettings().packages) kb.text(packageLabel(p), `buy:${p.id}`).row();
    try {
      await bot.api.sendMessage(
        r.userId,
        `⏳ Твой VPN заканчивается ${when}.

` +
          `Чтобы не остаться без доступа, продли заранее — ключ останется тот же, ` +
          `ничего перенастраивать не нужно.`,
        { reply_markup: kb },
      );
    } catch (e) {
      console.error('Не смог напомнить клиенту', r.userId, e instanceof Error ? e.message : e);
    }
    markReminded(r.key);
  }
}
setInterval(() => void sweepReminders(), 60 * 60 * 1000);
void sweepReminders();


// ── оплата картой: подключает сам владелец ────────────────────────────────
// Всё, что нужно от него, — ключ из кабинета Tribute. Идентификаторы товаров бот
// достаёт по этому же ключу сам: в прошлый раз их вбивали руками, перепутали числовой id
// со ссылочным, и кнопка оплаты вела в никуда. Чего человек не вводит, то он не перепутает.
let productCache: { at: number; rows: TributeProduct[] } | null = null;

async function tributeProducts(force = false): Promise<TributeProduct[]> {
  const key = getSettings().tribute.apiKey;
  if (!key) return [];
  if (!force && productCache && Date.now() - productCache.at < 5 * 60 * 1000) return productCache.rows;
  const v = await verifyTributeKey(key);
  if (!v.ok) throw new Error(v.reason === 'invalid' ? 'ключ больше не подходит — введи новый' : v.detail);
  productCache = { at: Date.now(), rows: v.rows };
  return v.rows;
}

/** Когда что-то было, человеческими словами: «12 минут назад» понятнее, чем метка времени. */
function ago(at?: number): string {
  if (!at) return 'ни разу';
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин. назад`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} ч. назад` : `${Math.round(h / 24)} дн. назад`;
}

/**
 * Экран настройки — намеренно чек-лист, а не сводка состояния. «Оплата не работает» само
 * по себе не говорит НИЧЕГО: не введён ключ, не привязаны товары, не вставлен адрес в
 * Tribute и выключенный приём выглядят снаружи одинаково. Здесь видно, какой именно шаг
 * не сделан и что делать дальше.
 */
function cardText(note?: string): string {
  const s = getSettings();
  const t = s.tribute;
  const url = webhookUrl();
  const st = tributeStatus();
  const unbound = s.packages.filter((p) => !t.products.some((x) => x.pkgId === p.id));
  const ready = t.apiKey !== null && t.products.length > 0;

  const lines = ['💳 Оплата картой и СБП (через Tribute)', ''];

  if (!url) {
    // Не молчим и не показываем шаги, которые всё равно ни к чему не приведут.
    lines.push(
      '⚠️ У этого сервера нет доменного имени с сертификатом, а без него Tribute не сможет',
      'сообщить об оплате. Оплату картой тут включить нельзя — напиши в станок.',
    );
    return lines.join('\n');
  }

  lines.push(`1. Ключ Tribute — ${t.apiKey ? '✅ принят' : '❌ не введён'}`);
  lines.push(
    `2. Тарифы привязаны к товарам — ${t.products.length} из ${s.packages.length}` +
      (t.apiKey === null ? ' (сначала ключ)' : unbound.length > 0 ? ` ❌ без оплаты картой: ${unbound.map((p) => p.days + ' дн.').join(', ')}` : ' ✅'),
  );
  lines.push(
    `3. Адрес вставлен в кабинете Tribute — ` +
      (st.lastEventAt
        ? `✅ события приходят (последнее ${ago(st.lastEventAt)})`
        : st.lastBadSigAt
          ? `⚠️ стучатся, но подпись не сходится (${ago(st.lastBadSigAt)}) — скорее всего ключ здесь не от того кабинета`
          : '❓ ни одного события ещё не приходило'),
  );
  lines.push(`4. Приём включён — ${t.enabled && ready ? '🟢 да' : '🔴 нет'}`);

  lines.push('', 'Адрес для кабинета Tribute (Настройки → API-ключи → webhook):', `<code>${url}</code>`);

  // Ровно один следующий шаг: список из четырёх дел одновременно читается как «всё сломано».
  const next = !t.apiKey
    ? 'Дальше: нажми «Ввести ключ Tribute».'
    : t.products.length === 0
      ? 'Дальше: нажми «Привязать тарифы» — бот покажет твои товары из Tribute.'
      : !t.enabled
        ? 'Дальше: нажми «Включить» — после этого бот начнёт принимать оплаты.'
        : !st.lastEventAt
          ? 'Дальше: вставь адрес выше в кабинете Tribute и нажми там «Отправить тестовый запрос» — я сразу напишу, что получил.'
          : 'Всё настроено. Кнопка «Оплатить картой» показывается клиентам рядом со звёздами.';
  lines.push('', next);
  if (note) lines.push('', note);
  return lines.join('\n');
}

function cardMenu(): InlineKeyboard {
  const t = getSettings().tribute;
  const kb = new InlineKeyboard().text(t.apiKey ? '🔑 Заменить ключ' : '🔑 Ввести ключ Tribute', 'tribkey').row();
  if (t.apiKey) {
    kb.text('🔗 Привязать тарифы', 'tribbind').row();
    if (t.products.length > 0) kb.text(t.enabled ? '🔴 Выключить' : '🟢 Включить', 'tribtoggle').row();
    kb.text('🩺 Проверить приём', 'tribcheck').row();
  }
  return kb.text('← Назад', 'admin');
}

async function showCard(ctx: any, note?: string): Promise<void> {
  const text = cardText(note);
  const opts = { reply_markup: cardMenu(), parse_mode: 'HTML' as const };
  await ctx.editMessageText(text, opts).catch(async () => {
    await ctx.reply(text, opts);
  });
}

bot.callbackQuery('cardcfg', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await showCard(ctx);
});

bot.callbackQuery('tribkey', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(
    'Пришли API-ключ из Tribute: в их боте открой кабинет → «…» → Настройки → API-ключи.\n\n' +
      'Сообщение с ключом я сразу удалю из чата — он не должен висеть в переписке.',
    { reply_markup: ask('tribute-key') },
  );
});

bot.callbackQuery('tribtoggle', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  updateSettings((cur) => ({ ...cur, tribute: { ...cur.tribute, enabled: !cur.tribute.enabled } }));
  syncTributeServer();
  logSetup(getSettings().tribute.enabled ? 'enabled' : 'disabled');
  await showCard(ctx, getSettings().tribute.enabled ? '🟢 Приём оплат картой включён.' : '🔴 Приём оплат картой выключен.');
});

// Самопроверка: бот стучится на свой же публичный адрес и говорит, дойдёт ли до него
// Tribute. Без неё владельцу оставалось бы гадать между «не вставил адрес», «порт закрыт»
// и «сертификат протух» — снаружи это одно и то же молчание.
bot.callbackQuery('tribcheck', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const r = await selfCheck();
  logSetup(r.ok ? 'selfcheck-ok' : 'selfcheck-fail', r.text);
  const st = tributeStatus();
  await showCard(
    ctx,
    `${r.ok ? '✅' : '❌'} ${r.text}` +
      '\n\n' +
      `Событий от Tribute принято: ${st.delivered}, отклонено по подписи: ${st.rejected}.`,
  );
});

bot.callbackQuery('tribbind', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = getSettings();
  const kb = new InlineKeyboard();
  for (const p of s.packages) {
    const bound = s.tribute.products.find((x) => x.pkgId === p.id);
    kb.text(`${p.days} дн. — ${bound ? bound.label : 'не привязан'}`, `tribpkg:${p.id}`).row();
  }
  kb.text('← Назад', 'cardcfg');
  await ctx
    .editMessageText('Выбери тариф, чтобы указать, какой товар Tribute ему соответствует.', { reply_markup: kb })
    .catch(() => {});
});

bot.callbackQuery(/^tribpkg:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const pkgId = ctx.match[1];
  let rows: TributeProduct[];
  try {
    rows = await tributeProducts(true);
  } catch (e) {
    await showCard(ctx, `❌ Не смог получить товары из Tribute: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (rows.length === 0) {
    logSetup('bind-empty');
    await showCard(ctx, '❌ В твоём Tribute нет ни одного товара — сначала создай их там, потом привязывай.');
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of rows) kb.text(`${r.name} — ${priceLabel(r)}`, `tribset:${pkgId}:${r.id}`).row();
  kb.text('🗑 Убрать привязку', `tribset:${pkgId}:-`).row().text('← Назад', 'tribbind');
  await ctx.editMessageText('Какой товар Tribute соответствует этому тарифу?', { reply_markup: kb }).catch(() => {});
});

bot.callbackQuery(/^tribset:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const [, pkgId, productId] = ctx.match;
  if (productId === '-') {
    updateSettings((cur) => ({
      ...cur,
      tribute: { ...cur.tribute, products: cur.tribute.products.filter((x) => x.pkgId !== pkgId) },
    }));
    logSetup('bind-off', pkgId);
    await showCard(ctx, '🗑 Привязка убрана — оплата картой у этого тарифа больше не предлагается.');
    return;
  }
  const rows = await tributeProducts().catch(() => [] as TributeProduct[]);
  const prod = rows.find((r) => r.id === productId);
  if (!prod) {
    logSetup('bind-gone', productId);
    await showCard(ctx, '❌ Такого товара в Tribute больше нет — обнови список и выбери заново.');
    return;
  }
  // И наоборот: один товар нельзя повесить на два тарифа. В вебхуке приходит только товар,
  // и по нему было бы не понять, какой срок выдавать — выдали бы наугад.
  const clash = getSettings().tribute.products.find((x) => x.productId === prod.id && x.pkgId !== pkgId);
  if (clash) {
    const other = findPackage(clash.pkgId);
    logSetup('bind-clash', `товар ${prod.id} уже у тарифа ${clash.pkgId}`);
    await showCard(
      ctx,
      `❌ Этот товар уже привязан к тарифу ${other ? other.days + ' дн.' : clash.pkgId}. ` +
        'Один товар — один тариф: иначе по оплате не понять, какой срок выдавать. ' +
        'Заведи в Tribute отдельный товар под этот срок.',
    );
    return;
  }
  updateSettings((cur) => ({
    ...cur,
    tribute: {
      ...cur.tribute,
      // Один тариф — один товар: старая привязка выбрасывается, иначе в карте копились бы
      // два товара на один тариф, и по вебхуку было бы непонятно, за что заплатили.
      products: [
        ...cur.tribute.products.filter((x) => x.pkgId !== pkgId),
        { pkgId, productId: prod.id, url: prod.webLink, label: priceLabel(prod) },
      ],
    },
  }));
  syncTributeServer();
  logSetup('bind-ok', `${pkgId} → ${prod.id}`);
  await showCard(ctx, `✅ Тариф привязан к «${prod.name}» (${priceLabel(prod)}).`);
});

// ── оплата картой (Tribute) ───────────────────────────────────────────────
/**
 * Событие оплаты от Tribute. Выдаём тем же путём, что и за звёзды (deliverPurchase) —
 * человек не должен получить меньше оттого, что заплатил картой.
 *
 * Всё, чего не понимаем, громко пишем в лог ВМЕСТЕ с сырым событием: прошлый раз
 * (06.09, товар 150556) в логе осталось только «нет в карте», и по этой записи нельзя
 * было понять, что именно пришло и почему не совпало.
 */
async function handleTributeEvent(ev: TributeWebhookEvent): Promise<void> {
  const p = ev.payload ?? {};
  const kind = eventKind(ev.name);
  // Тестовый запрос из кабинета Tribute — единственное доказательство, что адрес вставлен
  // верно и связь есть. Молча его проглотить значит лишить владельца этой проверки:
  // снаружи «дошло» и «не дошло» выглядят одинаково.
  if (kind === 'other') {
    logSetup('test-event', ev.name);
    const owner = getOwnerId();
    if (owner) {
      await bot.api
        .sendMessage(
          owner,
          `✅ Tribute достучался до бота (событие «${ev.name}»). Адрес вставлен верно, ` +
            'приём оплат работает. Это служебное событие, покупкой оно не является.',
        )
        .catch(() => {});
    }
    return;
  }

  const buyer = p.telegram_user_id;
  const productId = p.product_id;
  if (buyer === undefined || productId === undefined) return;

  const pkgId = packageForTributeProduct(productId);
  const pkg = pkgId ? findPackage(pkgId) : undefined;
  const ownerId = getOwnerId();

  if (kind === 'refund') {
    // Возврат не отбираем автоматически: подписка уже выдана, а решение «забрать доступ»
    // за владельца принимать нельзя. Его дело — мы только обязаны не промолчать.
    if (ownerId) {
      await bot.api
        .sendMessage(
          ownerId,
          `↩️ Tribute: возврат по товару ${productId}${pkg ? ` (тариф ${pkg.days} дн.)` : ''}, ` +
            `клиент ${buyer}. Доступ у него остался — если нужно отозвать, сделай это вручную.`,
        )
        .catch(() => {});
    }
    return;
  }

  if (!pkg) {
    logSetup('paid-unbound', `товар ${productId}`);
    console.error(
      `Tribute: оплачен товар ${productId} (тип ${typeof productId}), не привязанный ни к одному тарифу. ` +
        `Событие: ${JSON.stringify(ev).slice(0, 500)}`,
    );
    if (ownerId) {
      await bot.api
        .sendMessage(
          ownerId,
          `⚠️ Пришла оплата картой за товар, которого нет в привязке тарифов (${productId}).

` +
            `Клиент ${buyer} заплатил, но ключ не выдан. Открой «⚙️ Мой бот» → «💳 Оплата картой» ` +
            'и привяжи товар к тарифу — потом выдай доступ вручную.',
        )
        .catch(() => {});
    }
    return;
  }

  const charge = `tribute:${p.purchase_id ?? `${p.subscription_id}:${p.period_id}`}`;
  const ok = await deliverPurchase({ userId: buyer, pkg, stars: 0, charge, method: 'card' });
  logSetup('paid-ok', `${pkg.days} дн., выдано: ${ok ? 'да' : 'нет'}`);
  if (ownerId) {
    const sum = typeof p.amount === 'number' ? ` на ${priceLabel({ amount: p.amount, currency: String(p.currency ?? '') })}` : '';
    await bot.api
      .sendMessage(
        ownerId,
        ok
          ? `💳 Оплата картой${sum}: тариф ${pkg.days} дн., клиент ${buyer}. Ключ выдан.`
          : `⚠️ Оплата картой${sum} пришла (клиент ${buyer}), но ключ выдать не удалось — серверы не ответили.`,
      )
      .catch(() => {});
  }
}

/**
 * Стук с неверной подписью почти всегда значит одно: ключ у нас не от того кабинета —
 * Tribute подписывает тело как раз им. Владельцу об этом надо знать, иначе он будет
 * ждать оплат, которые молча отбиваются. Пишем не чаще раза в час: сканеры интернета
 * тоже стучатся в открытый порт, и превращать это в поток сообщений нельзя.
 */
let lastBadSigNotice = 0;
syncTributeServer(handleTributeEvent, () => {
  const owner = getOwnerId();
  if (!owner || Date.now() - lastBadSigNotice < 60 * 60 * 1000) return;
  lastBadSigNotice = Date.now();
  logSetup('badsig');
  void bot.api
    .sendMessage(
      owner,
      '⚠️ Кто-то стучится на адрес оплаты, но подпись не сходится.' + '\n\n' +
        'Если это Tribute — значит ключ здесь не от того кабинета: замени его в ' +
        '«⚙️ Мой бот» → «💳 Оплата картой». Пока подпись не сходится, оплаты не засчитываются.',
    )
    .catch(() => {});
});
watchTributeCert();

await bot.start({
  onStart: (info) => console.log(`Бот-продавец @${info.username} запущен, версия ${currentVersion()}`),
});
