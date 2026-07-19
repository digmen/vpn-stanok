import { Buffer } from 'node:buffer';
import { Bot, InlineKeyboard, InputFile, type Api } from 'grammy';
import QRCode from 'qrcode';

// Временное хранилище конфигов между «сгенерили» и «пользователь выбрал формат».
const store = new Map<string, string>();

function stash(cfg: string): string {
  const id = Math.random().toString(36).slice(2, 10);
  store.set(id, cfg);
  if (store.size > 200) {
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
  return id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Предлагаем выбрать формат — человек берёт только то, что нужно (не всё сразу).
export async function offerConfig(api: Api, chatId: number, config: string): Promise<void> {
  const id = stash(config);
  const kb = new InlineKeyboard()
    .text('🔳 QR', `fmt:qr:${id}`)
    .text('📄 Файл', `fmt:file:${id}`)
    .text('📋 Текст', `fmt:text:${id}`);
  await api.sendMessage(chatId, '✅ Твой VPN готов. Как получить конфиг?', { reply_markup: kb });
}

export function registerDeliveryHandlers(bot: Bot): void {
  bot.callbackQuery(/^fmt:(qr|file|text):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const fmt = ctx.match[1];
    const cfg = store.get(ctx.match[2]);
    const chatId = ctx.chat!.id;
    if (!cfg) {
      await ctx.reply('Ссылка на конфиг устарела — сгенерируй заново.');
      return;
    }
    if (fmt === 'file') {
      await ctx.api.sendDocument(chatId, new InputFile(Buffer.from(cfg, 'utf8'), 'amnezia.conf'), {
        caption: 'В AmneziaVPN: ＋ → импорт из файла.',
      });
    } else if (fmt === 'qr') {
      const qr = await QRCode.toBuffer(cfg, { width: 512, margin: 1 });
      await ctx.api.sendPhoto(chatId, new InputFile(qr, 'amnezia-qr.png'), {
        caption: 'В AmneziaVPN: ＋ → сканировать QR.',
      });
    } else {
      await ctx.api.sendMessage(chatId, '<pre>' + escapeHtml(cfg) + '</pre>', { parse_mode: 'HTML' });
    }
    // Убираем сообщение «Как получить конфиг?» — оставляем только сам конфиг
    await ctx.deleteMessage().catch(() => {});
  });
}
