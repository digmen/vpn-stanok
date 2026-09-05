import { Buffer } from 'node:buffer';
import { Bot, InlineKeyboard, InputFile, type Api } from 'grammy';
import QRCode from 'qrcode';
import type { VpnProtocol } from './locations.js';

/**
 * Приложение под каждый протокол. Раньше (до 06.09) весь модуль был захардкожен
 * под AmneziaVPN — правильно, пока был всего один протокол. С появлением
 * VLESS+Reality это стало реальным багом: покупатель VLESS-ключа получал бы
 * инструкцию «В AmneziaVPN: ＋ → импорт из файла», а AmneziaVPN такой ключ вообще
 * не откроет. Перенесено сюда решение, уже проверенное и починенное на форке
 * `vpn-stanok-alexander` (тот же баг там ловили на живом клиенте 28.08).
 */
export const APPS: Record<VpnProtocol, { name: string; android: string; ios: string }> = {
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
};

/** Кнопки установки нужного приложения — под конкретный ключ, не общей кнопкой в меню. */
export function appKeyboard(protocol: VpnProtocol): InlineKeyboard {
  const a = APPS[protocol];
  return new InlineKeyboard().url('🤖 Android — ' + a.name, a.android).row().url('🍎 iPhone — ' + a.name, a.ios);
}

const PROTOCOL_COPY: Record<VpnProtocol, { file: string; qr: string; text: string; app: string; ext: string }> = {
  amneziawg: {
    app: 'amnezia',
    ext: 'conf',
    file: 'В AmneziaVPN: ＋ → импорт из файла.',
    qr: 'В AmneziaVPN: ＋ → сканировать QR.',
    text: '',
  },
  vless_reality: {
    app: 'vless',
    ext: 'txt',
    file: 'Ссылка внутри файла — скопируй и вставь в OneXray: ＋ → импорт по ссылке.',
    qr: 'В OneXray: ＋ → сканировать QR.',
    text: 'Скопируй ссылку целиком и вставь в OneXray: ＋ → импорт по ссылке.',
  },
};

// Временное хранилище конфигов между «сгенерили» и «пользователь выбрал формат».
// Вместе с конфигом держим название локации (несколько стран — иначе все кнопки
// на вид одинаковые) и протокол (чтобы подпись/имя файла/кнопка приложения ехали
// под правильный клиент — см. PROTOCOL_COPY/APPS выше).
const store = new Map<string, { cfg: string; title: string; protocol: VpnProtocol }>();

function stash(cfg: string, title: string, protocol: VpnProtocol): string {
  const id = Math.random().toString(36).slice(2, 10);
  store.set(id, { cfg, title, protocol });
  if (store.size > 200) {
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
  return id;
}

/** Имя файла из названия локации: «Лондон» → amnezia-London.conf / vless-London.txt. */
function fileNameFor(title: string, protocol: VpnProtocol): string {
  const { app, ext } = PROTOCOL_COPY[protocol];
  const ascii = title.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii ? `${app}-${ascii}.${ext}` : `${app}.${ext}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 🔴 26.08: живой случай (Александр, Амстердам) — на Android VPN не подключался вообще
// (ни по Wi-Fi, ни по мобильному), хотя на iPhone и ноуте всё работало. 4 часа искали
// проблему в сервере — оказалось, дело в системной настройке телефона (Приватный DNS
// Android 9+ конфликтует с VPN-туннелем). Кладём подсказку сразу всем при выдаче
// конфига, а не только тем, кто написал в поддержку — иначе следующий покупатель
// на Android пройдёт те же четыре часа молча. Актуально для обоих протоколов —
// системная настройка телефона, не про конкретное приложение.
const ANDROID_HINT =
  '\n\n📱 Если на Android не подключается (крутится и не коннектится) — ' +
  'Настройки → Сеть и интернет → Приватный DNS → выключить.';

// Предлагаем выбрать формат — человек берёт только то, что нужно (не всё сразу).
export async function offerConfig(
  api: Api,
  chatId: number,
  config: string,
  title?: string,
  protocol: VpnProtocol = 'amneziawg',
): Promise<void> {
  const id = stash(config, title ?? '', protocol);
  const kb = new InlineKeyboard()
    .text('🔳 QR', `fmt:qr:${id}`)
    .text('📄 Файл', `fmt:file:${id}`)
    .text('📋 Текст', `fmt:text:${id}`);
  const head = title ? `✅ ${title} — ключ готов. Как получить?` : '✅ Твой VPN готов. Как получить конфиг?';
  await api.sendMessage(chatId, head + ANDROID_HINT, { reply_markup: kb });
}

/**
 * Несколько локаций разом. Отдельная функция, а не цикл на стороне вызова:
 * тут же объясняем человеку, зачем ему несколько ключей — иначе он видит
 * пачку одинаковых кнопок и не понимает, что произошло. Локации могут быть
 * разных протоколов одновременно (старый узел ещё на AmneziaWG, новый уже
 * на VLESS+Reality) — каждая идёт под своим приложением, не общим на все.
 */
export async function offerConfigs(
  api: Api,
  chatId: number,
  items: { config: string; title: string; protocol?: VpnProtocol }[],
): Promise<void> {
  if (items.length === 0) return;
  if (items.length === 1) {
    await offerConfig(api, chatId, items[0].config, items[0].title, items[0].protocol);
    return;
  }
  await api.sendMessage(
    chatId,
    `✅ Готово! У тебя доступ к ${items.length} серверам: ${items.map((i) => i.title).join(', ')}.\n\n` +
      'Добавь в приложение все — если один перестанет работать, просто переключишься на другой.',
  );
  for (const it of items) {
    await offerConfig(api, chatId, it.config, it.title, it.protocol);
  }
}

export function registerDeliveryHandlers(bot: Bot): void {
  bot.callbackQuery(/^fmt:(qr|file|text):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const fmt = ctx.match[1];
    const item = store.get(ctx.match[2]);
    const chatId = ctx.chat!.id;
    if (!item) {
      await ctx.reply('Ссылка на конфиг устарела — сгенерируй заново.');
      return;
    }
    const { cfg, title, protocol } = item;
    const copy = PROTOCOL_COPY[protocol];
    const label = title ? `${title} · ` : '';
    // Приложение подсказываем ПРЯМО с ключом: протокол уже известен, и это
    // единственное сообщение, которое человек точно откроет.
    const appKb = appKeyboard(protocol);
    if (fmt === 'file') {
      await ctx.api.sendDocument(chatId, new InputFile(Buffer.from(cfg, 'utf8'), fileNameFor(title, protocol)), {
        caption: label + copy.file,
        reply_markup: appKb,
      });
    } else if (fmt === 'qr') {
      const qr = await QRCode.toBuffer(cfg, { width: 512, margin: 1 });
      await ctx.api.sendPhoto(chatId, new InputFile(qr, `${copy.app}-qr.png`), {
        caption: label + copy.qr,
        reply_markup: appKb,
      });
    } else {
      const textCaption = copy.text ? `\n${copy.text}` : '';
      await ctx.api.sendMessage(
        chatId,
        (title ? `<b>${escapeHtml(title)}</b>\n` : '') + '<pre>' + escapeHtml(cfg) + '</pre>' + textCaption,
        { parse_mode: 'HTML', reply_markup: appKb },
      );
    }
    // Убираем сообщение «Как получить конфиг?» — оставляем только сам конфиг
    await ctx.deleteMessage().catch(() => {});
  });
}
