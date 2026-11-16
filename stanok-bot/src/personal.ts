import { Buffer } from 'node:buffer';
import { InlineKeyboard, InputFile, type Api } from 'grammy';
import QRCode from 'qrcode';
import type { NodeMode, NodeProtocol } from './db.js';
import { kvGet, kvSet } from './kv.js';

// «Свой VPN для себя» — второй сценарий станка рядом с VPN-бизнесом.
//
// 17.11.2026: разбор рефералов хостинга показал, что серверы бросают те, кому VPN был нужен
// как бизнес (продать не вышло — сервер не продлили), а спрос на «свой VPN на своём сервере»
// большой сам по себе. Поэтому на первом экране теперь главная кнопка — свой VPN, а
// «продавай доступ другим» второй. Путь «для себя» тот же (сервер → IP → пароль → протокол →
// установка), только без токена @BotFather и без бота-продавца: ключ — первый клиент, которого
// install-скрипт и так создаёт на сервере (email "owner"), станок отдаёт его прямо в чат.
//
// Режим человека хранится в kv (`mode:<id>`), а не в сессии: сессия grammY живёт в памяти и
// обнуляется при каждом деплое, а кнопки «Настроить» из напоминаний приходят через сутки.
// Кто режим не выбирал (старые сообщения и кнопки), идёт по бизнес-пути — как было до 17.11.

export const MODE_CALLBACK_PREFIX = 'mode:';
export const UPGRADE_CALLBACK_PREFIX = 'upgrade:';

/** `mode:personal` → 'personal'; всё чужое → null. */
export function parseModeCallback(data: string): NodeMode | null {
  if (!data.startsWith(MODE_CALLBACK_PREFIX)) return null;
  const m = data.slice(MODE_CALLBACK_PREFIX.length);
  return m === 'personal' || m === 'business' ? m : null;
}

const modeKey = (userId: number): string => `mode:${userId}`;

/** Что человек выбрал на первом экране. Не выбирал — 'business' (поведение до 17.11). */
export function getUserMode(userId: number): NodeMode {
  return kvGet(modeKey(userId)) === 'personal' ? 'personal' : 'business';
}

export function setUserMode(userId: number, mode: NodeMode): void {
  kvSet(modeKey(userId), mode);
}

// ── Первый экран ─────────────────────────────────────────────────────────

export const START_TEXT =
  'Привет! 👋\n\n' +
  '🔒 Здесь ты за 5 минут поднимешь свой VPN на своём сервере. Он только твой — ни с кем ' +
  'не делишь.\n\n' +
  '• Всё с телефона, компьютер и консоль не нужны — я настрою сервер сам.\n' +
  '• Платишь только хостингу за сервер.\n' +
  '• Ключ получишь прямо здесь — ссылкой и QR-кодом, с кнопками на приложение.\n\n' +
  '💰 Хочешь ещё и зарабатывать — продавать доступ другим через своего бота за ⭐️ — жми «VPN-бизнес».';

export function startKeyboard(supportUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🔒 Свой VPN для себя', MODE_CALLBACK_PREFIX + 'personal')
    .row()
    .text('💰 VPN-бизнес: продавай доступ', MODE_CALLBACK_PREFIX + 'business');
  if (supportUrl) kb.row().url('🆘 Поддержка', supportUrl);
  return kb;
}

/** Совет про срок и выделенный IP — общий для экрана «для себя» и инструкции покупки. */
export const MONTH_AND_IP_ADVICE =
  '💡 Бери сервер сразу на месяц, а не на пробные дни или неделю: кончится срок — хостинг отключит ' +
  'сервер вместе с твоим VPN, и настраивать придётся заново.\n' +
  '⚠️ Обязательно отметь «Выделенный IP» (~50–65 ₽). Без него сервер спрятан за NAT хостинга, ' +
  'и VPN не заработает — это причина 9 из 10 неудач.';

export const PERSONAL_TEXT =
  '🔒 Свой VPN для себя — три шага:\n\n' +
  '1. Купить сервер у хостинга — «Как купить сервер», там всё по шагам.\n' +
  '2. Прислать мне IP и root-пароль сервера — к каждому покажу, где взять.\n' +
  '3. Нажать «Поднять VPN» — через пару минут пришлю твой ключ.\n\n' +
  MONTH_AND_IP_ADVICE +
  '\n\nСервер уже есть — жми «Я уже купил сервер».';

/** Экран бизнес-сценария — бывший первый экран станка (до 17.11), текст без изменений. */
export const BUSINESS_TEXT =
  '💰 VPN-бизнес\n\n' +
  'Здесь ты за пару минут получишь свой VPN-сервер и бота, через которого сможешь ' +
  'продавать VPN за ⭐️ Telegram Stars.\n\n' +
  '━━━━━━━━━━━━━━\n' +
  'Всего три шага:\n' +
  '1. Купить сервер у хостинга — «Как купить сервер», там всё по шагам. Первые 7 дней можно бесплатно.\n' +
  '2. Прислать мне IP и пароль сервера и токен бота — к каждому покажу, где взять.\n' +
  '3. Нажать «Поднять VPN» — дальше я всё сделаю сам.\n\n' +
  '⚠️ При покупке обязательно отметь «Выделенный IP» (~50–65 ₽). Без него сервер спрятан ' +
  'за NAT хостинга — ни я не смогу его настроить, ни клиенты не подключатся. ' +
  'Это причина 9 из 10 неудач.\n\n' +
  'Сервер уже есть — жми «Я уже купил сервер».';

export function modeText(mode: NodeMode): string {
  return mode === 'personal' ? PERSONAL_TEXT : BUSINESS_TEXT;
}

/** Кнопки под экраном режима: купить / уже купил / сменить режим. */
export function modeKeyboard(mode: NodeMode, supportUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🛒 Как купить сервер', 'buy')
    .row()
    .text('✅ Я уже купил сервер', 'bought')
    .row()
    .text(
      mode === 'personal' ? '💰 Мне нужен VPN-бизнес' : '🔒 Мне нужен VPN только для себя',
      MODE_CALLBACK_PREFIX + (mode === 'personal' ? 'business' : 'personal'),
    );
  if (supportUrl) kb.row().url('🆘 Поддержка', supportUrl);
  return kb;
}

export function step2Text(mode: NodeMode): string {
  if (mode === 'personal') {
    return (
      '📍 Шаг 2. Настройка сервера\n\n' +
      'Сейчас я попрошу доступ к серверу, чтобы настроить его в автоматическом режиме.\n\n' +
      'Мне нужны:\n' +
      '1. IP — сразу проверю, отвечает ли сервер\n' +
      '2. Root-пароль (спрошу, только если сервер отозвался)\n\n' +
      'Бота заводить не нужно — ключ пришлю прямо сюда.\n\n' +
      'Жми «Настроить».'
    );
  }
  return (
    '📍 Шаг 2. Настройка сервера\n\n' +
    'Сейчас я попрошу дать доступ к серверу, чтобы настроить его в автоматическом режиме.\n\n' +
    'Мне нужны:\n' +
    '1. IP — сразу проверю, отвечает ли сервер\n' +
    '2. Пароль (спрошу, только если сервер отозвался)\n' +
    '3. Токен бота — его можно получить, создав бота через @BotFather\n\n' +
    'К каждому шагу буду давать инструкцию.\n\n' +
    'Жми «Настроить».'
  );
}

// ── Готовый личный VPN: ключ и приложения ────────────────────────────────

// Ссылки и подсказки те же, что выдаёт клиентам бот-продавец (seller-bot/src/delivery.ts:
// APPS и PROTOCOL_COPY). Станок и бот — разные пакеты, импортировать оттуда нельзя, поэтому
// копия; меняешь там — поменяй и здесь.
export const APPS: Record<NodeProtocol, { name: string; android: string; ios: string }> = {
  amneziawg: {
    name: 'AmneziaVPN',
    android: 'https://play.google.com/store/apps/details?id=org.amnezia.vpn',
    ios: 'https://amnezia.org/downloads',
  },
  vless_reality: {
    name: 'OneXray',
    android: 'https://play.google.com/store/apps/details?id=net.yuandev.onexray&hl=ru',
    ios: 'https://apps.apple.com/ru/app/onexray/id6745748773',
  },
  vless_ws_tls: {
    name: 'OneXray',
    android: 'https://play.google.com/store/apps/details?id=net.yuandev.onexray&hl=ru',
    ios: 'https://apps.apple.com/ru/app/onexray/id6745748773',
  },
};

/** Как добавить ключ в приложение — по протоколу. */
export function howToImport(protocol: NodeProtocol): string {
  return protocol === 'amneziawg'
    ? 'В AmneziaVPN: ＋ → импорт из файла (файл ниже) или ＋ → сканировать QR.'
    : 'В OneXray: ＋ → импорт по ссылке (ссылка ниже, скопируй целиком) или ＋ → сканировать QR.';
}

export function personalReadyText(ip: string, protocol: NodeProtocol, warning = ''): string {
  return (
    `🎉 Готово! Твой личный VPN работает (сервер ${ip}).\n\n` +
    'Как подключиться:\n' +
    `1. Поставь приложение ${APPS[protocol].name} — кнопки ниже.\n` +
    `2. ${howToImport(protocol)}\n` +
    '3. Включи VPN.\n\n' +
    '🔑 Ключ только твой — не публикуй его: кто получит ключ, тот пользуется твоим сервером.' +
    // VLESS-ключ работает на нескольких устройствах сразу; у AmneziaWG один конфиг = одно
    // подключение (второе устройство с тем же ключом выбивает первое), поэтому там молчим.
    (protocol === 'amneziawg' ? '' : ' Тот же ключ можно поставить и на свой второй телефон или ноутбук.') +
    '\n\n' +
    '⏰ VPN работает, пока сервер оплачен. Продлевай его в панели хостинга вовремя — я напомню.' +
    warning
  );
}

export function personalReadyKeyboard(protocol: NodeProtocol, nodeId: number, supportUrl?: string): InlineKeyboard {
  const a = APPS[protocol];
  const kb = new InlineKeyboard()
    .url('🤖 Android — ' + a.name, a.android)
    .row()
    .url('🍎 iPhone — ' + a.name, a.ios)
    .row()
    .text('💰 Зарабатывать на этом сервере', UPGRADE_CALLBACK_PREFIX + nodeId);
  if (supportUrl) kb.row().url('🆘 Поддержка', supportUrl);
  return kb;
}

/** Предупреждение, если тестовый клиент из России до сервера не достал (обход для личных
 *  узлов автоматически не включаем — релей устроен через бота-продавца, см. relay.ts). */
export const PERSONAL_RU_WARNING =
  '\n\n⚠️ Проверка из России показала, что напрямую оттуда сервер недоступен. Если ты в России ' +
  'и VPN не подключается — напиши в поддержку, разберёмся.';

/** «Подключить бота» — что будет, до того как человек отдаст токен. */
export const UPGRADE_INTRO =
  '💰 Зарабатывать на этом сервере\n\n' +
  'Поставлю на этот же сервер твоего бота-продавца: он сам продаёт доступ к VPN за ⭐️ Telegram Stars ' +
  'и выдаёт ключи покупателям. Твой личный ключ продолжит работать, сервер перенастраивать не нужно.\n\n' +
  'Понадобится только токен нового бота из @BotFather.';

export function personalRenewText(): string {
  return (
    '⏰ Напоминание про сервер\n\n' +
    'Твоему VPN скоро неделя. Если сервер брал на пробные дни или оплатил на неделю — срок ' +
    'вот-вот кончится. Продли его в панели хостинга (лучше сразу на месяц), иначе VPN отключится ' +
    'и настраивать придётся заново.'
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Имя файла ключа: amnezia-1-2-3-4.conf (точки в имени путают часть телефонов). */
export function keyFileName(ip: string): string {
  return `amnezia-${ip.replace(/\./g, '-')}.conf`;
}

/**
 * Отдаёт владельцу личного VPN его ключ: QR-код и сам ключ (ссылкой для OneXray или файлом
 * для AmneziaVPN). В журнал диалога ключ не попадает: chat-log.ts вырезает vless-ссылки и
 * конфиги с PrivateKey, а у фото и файла пишется только подпись, где ключа нет.
 */
export async function sendPersonalKey(
  api: Api,
  chatId: number,
  protocol: NodeProtocol,
  cfg: string,
  ip: string,
): Promise<void> {
  const qr = await QRCode.toBuffer(cfg, { width: 512, margin: 1 });
  await api.sendPhoto(chatId, new InputFile(qr, 'vpn-qr.png'), {
    caption: `QR-код твоего ключа. В ${APPS[protocol].name}: ＋ → сканировать QR.`,
  });
  if (protocol === 'amneziawg') {
    await api.sendDocument(chatId, new InputFile(Buffer.from(cfg, 'utf8'), keyFileName(ip)), {
      caption: 'Твой ключ файлом. В AmneziaVPN: ＋ → импорт из файла.',
    });
  } else {
    await api.sendMessage(
      chatId,
      '🔑 Твой ключ:\n<pre>' + escapeHtml(cfg) + '</pre>\nСкопируй ссылку целиком и вставь в OneXray: ＋ → импорт по ссылке.',
      { parse_mode: 'HTML' },
    );
  }
}
