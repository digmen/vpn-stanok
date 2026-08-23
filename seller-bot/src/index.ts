import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { promoEnabled } from './branding.js';
import { createVpnPeer, createVpnPeersEverywhere, revokePeerAt, type Peer } from './vpn.js';
import { activeClients, addSubscription, getExpiredPeers, removePeer, revenueStars } from './subscriptions.js';
import { offerConfig, offerConfigs, registerDeliveryHandlers } from './delivery.js';
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
} from './locations.js';
import { attachServer, ping } from './ssh.js';
import { claimOwnerIfUnset, getOwnerId } from './owner.js';
import { readOwnerConfig, saveOwnerConfig } from './owner-config.js';
import { buildStats, recordEvent } from './stats.js';
import { hasUsedTrial, markTrialUsed, trialCount } from './trials.js';
import { checkUpdate, currentVersion, startSelfUpdate } from './update.js';
import {
  findPackage,
  getSettings,
  isValidDays,
  isValidStars,
  LIMITS,
  nextPackageId,
  packageLabel,
  updateSettings,
} from './settings.js';

const bot = new Bot(config.botToken);
registerDeliveryHandlers(bot);

const APP_LINKS =
  '📱 Приложение AmneziaVPN — в него импортируется ключ:\n\n' +
  '• Android: https://play.google.com/store/apps/details?id=org.amnezia.vpn\n' +
  '• iPhone, компьютер и остальные: https://amnezia.org/downloads\n\n' +
  'Поставь приложение заранее — после оплаты пришлю ключ, его нужно будет открыть в нём.';

// Владелец вводит значение текстом. Одно ожидание за раз — состояние простое и не переживает
// перезапуск специально: зависшее ожидание не должно жевать чужие сообщения.
type PendingKind =
  | 'pkg-price' | 'pkg-days' | 'pkg-new-days' | 'pkg-new-stars'
  | 'welcome-text' | 'welcome-photo' | 'trial-days'
  // Добавление локации: сначала адрес, потом пароль, потом название
  | 'loc-host' | 'loc-password' | 'loc-title' | 'loc-rename';
let pending: { kind: PendingKind; arg?: string; at: number } | null = null;
const PROMPT_TTL_MS = 180_000;

const isOwner = (id?: number): boolean => id !== undefined && id === getOwnerId();
const expired = (): boolean => pending !== null && Date.now() - pending.at > PROMPT_TTL_MS;

function ask(kind: PendingKind, arg?: string): InlineKeyboard {
  pending = { kind, arg, at: Date.now() };
  return new InlineKeyboard().text('❌ Отмена', 'cancel');
}

// ── меню клиента ──────────────────────────────────────────────────────────
function mainMenu(owner: boolean, userId?: number): { text: string; kb: InlineKeyboard } {
  const s = getSettings();
  const kb = new InlineKeyboard();
  for (const p of s.packages) kb.text(`🛒 ${packageLabel(p)}`, `buy:${p.id}`).row();

  if (s.trial.enabled && userId !== undefined && !hasUsedTrial(userId) && !owner) {
    kb.text(`🎁 Попробовать бесплатно (${s.trial.days} дн.)`, 'trial').row();
  }
  kb.text('📱 Установить приложение', 'apps');
  // Каждая следующая кнопка своей строкой, но без пустых строк, если промо снято
  // (см. branding.ts): пустой ряд Telegram рисует как щель в меню.
  if (promoEnabled()) kb.row().url('💰 Заработай на своём VPN так же', config.stanokUrl);
  if (owner) kb.row().text('⚙️ Мой бот', 'admin');

  const text =
    s.welcome.text ??
    'Быстрый VPN за ⭐️ Telegram Stars.\n\n' +
      'Выбери срок — после оплаты пришлю ключ для приложения AmneziaVPN.' +
      (s.trial.enabled ? '\n\nЕсть бесплатный пробный период — кнопка ниже.' : '');
  return { text, kb };
}

// Последнее меню в чате — удаляем старое при новом /start (чат не засоряется).
const lastMenu = new Map<number, number>();

async function showMenu(ctx: any): Promise<void> {
  const s = getSettings();
  const chatId = ctx.chat.id;
  const prev = lastMenu.get(chatId);
  if (prev) await ctx.api.deleteMessage(chatId, prev).catch(() => {});

  const { text, kb } = mainMenu(isOwner(ctx.from?.id), ctx.from?.id);
  const m = s.welcome.photo
    ? await ctx.replyWithPhoto(s.welcome.photo, { caption: text, reply_markup: kb }).catch(() => null)
    : null;
  const msg = m ?? (await ctx.reply(text, { reply_markup: kb }));
  lastMenu.set(chatId, msg.message_id);
}

bot.command('start', async (ctx) => {
  pending = null;
  claimOwnerIfUnset(ctx.from!.id);
  await showMenu(ctx);
});

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  pending = null;
  await ctx.deleteMessage().catch(() => {});
  await showMenu(ctx);
});

bot.callbackQuery('apps', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(APP_LINKS, { link_preview_options: { is_disabled: true } });
});

bot.callbackQuery('cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  pending = null;
  await ctx.editMessageText('Отменено.').catch(() => {});
});

// ── покупка ───────────────────────────────────────────────────────────────
bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pkg = findPackage(ctx.match[1]);
  if (!pkg) {
    await ctx.reply('Этот тариф больше не действует — нажми /start и выбери заново.');
    return;
  }
  await ctx.replyWithInvoice(
    'VPN-доступ',
    `Доступ к VPN на ${pkg.days} дней`,
    `pkg:${pkg.id}`,
    'XTR', // Telegram Stars
    [{ label: `VPN ${pkg.days} дн.`, amount: pkg.stars }],
  );
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('message:successful_payment', async (ctx) => {
  const pay = ctx.message.successful_payment;
  const pkg = findPackage(pay.invoice_payload.replace(/^pkg:/, ''));
  const days = pkg?.days ?? config.days;
  recordEvent({ type: 'paid', stars: pay.total_amount, userId: ctx.from.id });
  // Платный тариф даёт доступ ко ВСЕМ локациям — ровно то, о чём просил
  // франчайзи: «покупает на месяц, а ему доступен Лондон, Финляндия».
  const peers = await generateEverywhere(ctx.api, ctx.chat.id);
  if (peers.length === 0) return;
  addSubscription(
    peers.map((p) => ({ loc: p.loc, pubkey: p.pubkey })),
    days,
    { userId: ctx.from.id, username: ctx.from.username, stars: pay.total_amount },
  );
  await offerConfigs(ctx.api, ctx.chat.id, peers.map((p) => ({ config: p.config, title: p.locTitle })));
});

// ── пробный период ────────────────────────────────────────────────────────
bot.callbackQuery('trial', async (ctx) => {
  await ctx.answerCallbackQuery();
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
  addSubscription([{ loc: peer.loc, pubkey: peer.pubkey }], s.trial.days, {
    userId,
    username: ctx.from?.username,
    stars: 0,
  });
  await offerConfig(ctx.api, ctx.chat!.id, peer.config, peer.locTitle);
  await ctx.reply(`🎁 Пробный доступ на ${s.trial.days} дн. активен. Приложение — кнопка «Установить приложение».`);
});

// ── кабинет владельца ─────────────────────────────────────────────────────
function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💲 Тарифы', 'tariffs')
    .text('🎁 Пробный период', 'trialcfg')
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

async function showAdmin(ctx: any, note?: string): Promise<void> {
  const s = getSettings();
  const text =
    '⚙️ Настройки твоего бота\n\n' +
    `Тарифов: ${s.packages.length}\n` +
    `Пробный период: ${s.trial.enabled ? `включён, ${s.trial.days} дн.` : 'выключен'}\n` +
    `Приветствие: ${s.welcome.text ? 'своё' : 'стандартное'}${s.welcome.photo ? ' + фото' : ''}\n` +
    `Версия бота: ${currentVersion()}` +
    (note ? `\n\n${note}` : '');
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
    .text('📅 Сколько дней', 'trialdays')
    .row()
    .text('← Назад', 'admin');
  await ctx
    .editMessageText(
      `🎁 Пробный период\n\nСейчас: ${s.trial.enabled ? `включён, ${s.trial.days} дн.` : 'выключен'}\n` +
        `Выдан: ${trialCount()} раз(а). Один человек — один раз.`,
      { reply_markup: kb },
    )
    .catch(() => {});
});

bot.callbackQuery('trialtoggle', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const s = updateSettings((cur) => ({ ...cur, trial: { ...cur.trial, enabled: !cur.trial.enabled } }));
  await showAdmin(ctx, s.trial.enabled ? '🟢 Пробный период включён.' : '🔴 Пробный период выключен.');
});

bot.callbackQuery('trialdays', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(`Сколько дней давать бесплатно? Сейчас: ${getSettings().trial.days}`, {
    reply_markup: ask('trial-days'),
  });
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
              `• ${r.who} — осталось ${r.daysLeft} дн.${r.stars ? ` · ${r.stars} ⭐` : ' · пробный'}` +
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
      '⚠️ На сервере уже должен быть поднят VPN — заведи его через ' +
      `${config.stanokUrl}, а потом добавь сюда.`,
    { reply_markup: ask('loc-host'), link_preview_options: { is_disabled: true } },
  );
});

bot.callbackQuery(/^loc:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx.from?.id)) return;
  const loc = findLocation(ctx.match[1]);
  if (!loc) return;
  const kb = new InlineKeyboard().text('✏️ Переименовать', `locren:${loc.id}`);
  if (loc.kind !== 'local') kb.text('🗑 Убрать', `locdel:${loc.id}`);
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

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  await ctx.reply(await buildStats());
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
  if (!pending || !isOwner(ctx.from?.id)) return;
  if (expired()) {
    pending = null;
    return;
  }
  const text = ctx.message.text.trim();
  const n = Number(text);
  const { kind, arg } = pending;

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
    try {
      const { privateKey, amneziaInstalled } = await attachServer(host, 'root', password, port ?? 22);
      if (!amneziaInstalled) {
        await ctx.api
          .editMessageText(
            ctx.chat.id,
            wait.message_id,
            '❌ Зайти получилось, но VPN на этом сервере не найден.\n\n' +
              `Сначала подними на нём VPN через ${config.stanokUrl}, потом добавь сюда.`,
            { link_preview_options: { is_disabled: true } },
          )
          .catch(() => {});
        return;
      }
      const id = nextLocationId();
      const keyFile = `loc-${id}.key`;
      saveKey(keyFile, privateKey);
      addRemote({ id, title: host, host, ...(port ? { port } : {}), user: 'root', keyFile });
      await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(
        `✅ Сервер ${host} подключён.\n\nКак назвать эту локацию? Название увидят клиенты — ` +
          'пришли страну или город, например «Лондон».',
        { reply_markup: ask('loc-title', id) },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.api
        .editMessageText(ctx.chat.id, wait.message_id, '❌ Не получилось подключиться.\n\nТех. детали:\n' + msg)
        .catch(() => {});
    }
    return;
  }

  if (kind === 'loc-title' || kind === 'loc-rename') {
    pending = null;
    renameLocation(arg!, text);
    await ctx.reply(`✅ Локация теперь называется «${text.trim().slice(0, LOCATION_LIMITS.MAX_TITLE_LEN)}».`);
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

  if (kind === 'pkg-days' || kind === 'trial-days' || kind === 'pkg-new-days') {
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
    } else if (kind === 'trial-days') {
      updateSettings((cur) => ({ ...cur, trial: { ...cur.trial, days: n } }));
      pending = null;
      await ctx.reply(`✅ Пробный период: ${n} дн.`);
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

await bot.start({
  onStart: (info) => console.log(`Бот-продавец @${info.username} запущен, версия ${currentVersion()}`),
});
