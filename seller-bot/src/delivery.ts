import { Buffer } from 'node:buffer';
import { Bot, InlineKeyboard, InputFile, type Api } from 'grammy';
import QRCode from 'qrcode';

// Временное хранилище конфигов между «сгенерили» и «пользователь выбрал формат».
// Вместе с конфигом держим название локации: с несколькими странами у человека
// в чате оказывается несколько одинаковых на вид кнопок, и без подписи он не
// поймёт, какой файл к какой стране (и назовёт их все amnezia.conf).
const store = new Map<string, { cfg: string; title: string }>();

function stash(cfg: string, title: string): string {
  const id = Math.random().toString(36).slice(2, 10);
  store.set(id, { cfg, title });
  if (store.size > 200) {
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
  return id;
}

/** Имя файла из названия локации: «Лондон» → amnezia-London.conf для латиницы,
 *  для кириллицы/тайского откатываемся на нейтральное — не все клиенты
 *  корректно принимают не-ASCII имена вложений. */
function fileNameFor(title: string): string {
  const ascii = title.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii ? `amnezia-${ascii}.conf` : 'amnezia.conf';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 🔴 26.08: живой случай (Александр, Амстердам) — на Android VPN не подключался вообще
// (ни по Wi-Fi, ни по мобильному), хотя на iPhone и ноуте всё работало. 4 часа искали
// проблему в сервере — оказалось, дело в системной настройке телефона (Приватный DNS
// Android 9+ конфликтует с VPN-туннелем). Кладём подсказку сразу всем при выдаче
// конфига, а не только тем, кто написал в поддержку — иначе следующий покупатель
// на Android пройдёт те же четыре часа молча.
const ANDROID_HINT =
  '\n\n📱 Если на Android не подключается (крутится и не коннектится) — ' +
  'Настройки → Сеть и интернет → Приватный DNS → выключить.';

// Предлагаем выбрать формат — человек берёт только то, что нужно (не всё сразу).
export async function offerConfig(api: Api, chatId: number, config: string, title?: string): Promise<void> {
  const id = stash(config, title ?? '');
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
 * пачку одинаковых кнопок и не понимает, что произошло.
 */
export async function offerConfigs(
  api: Api,
  chatId: number,
  items: { config: string; title: string }[],
): Promise<void> {
  if (items.length === 0) return;
  if (items.length === 1) {
    await offerConfig(api, chatId, items[0].config, items[0].title);
    return;
  }
  await api.sendMessage(
    chatId,
    `✅ Готово! У тебя доступ к ${items.length} серверам: ${items.map((i) => i.title).join(', ')}.\n\n` +
      'Добавь в приложение все — если один перестанет работать, просто переключишься на другой.',
  );
  for (const it of items) {
    await offerConfig(api, chatId, it.config, it.title);
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
    const { cfg, title } = item;
    const label = title ? `${title} · ` : '';
    if (fmt === 'file') {
      await ctx.api.sendDocument(chatId, new InputFile(Buffer.from(cfg, 'utf8'), fileNameFor(title)), {
        caption: label + 'В AmneziaVPN: ＋ → импорт из файла.',
      });
    } else if (fmt === 'qr') {
      const qr = await QRCode.toBuffer(cfg, { width: 512, margin: 1 });
      await ctx.api.sendPhoto(chatId, new InputFile(qr, 'amnezia-qr.png'), {
        caption: label + 'В AmneziaVPN: ＋ → сканировать QR.',
      });
    } else {
      await ctx.api.sendMessage(chatId, (title ? `<b>${escapeHtml(title)}</b>\n` : '') + '<pre>' + escapeHtml(cfg) + '</pre>', {
        parse_mode: 'HTML',
      });
    }
    // Убираем сообщение «Как получить конфиг?» — оставляем только сам конфиг
    await ctx.deleteMessage().catch(() => {});
  });
}
