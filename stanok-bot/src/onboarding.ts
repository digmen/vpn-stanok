import type { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { InlineKeyboard, type Context } from 'grammy';
import { config } from './config.js';
import { encrypt } from './crypto.js';
import { insertNode } from './db.js';
import { isNonEmptySecret, isValidBotToken, isValidIpv4 } from './validate.js';

export type MyContext = Context & ConversationFlavor;
export type MyConversation = Conversation<MyContext>;

async function del(ctx: MyContext, msgId: number): Promise<void> {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, msgId);
  } catch {
    /* уже удалено / нельзя — не мешаем */
  }
}

// Один шаг: (опц. видео) + вопрос, ждём валидный ответ, чистим за собой все сообщения шага.
async function askStep(
  conversation: MyConversation,
  ctx: MyContext,
  opts: { video: string; prompt: string; validate: (s: string) => boolean; errorMsg: string },
): Promise<string> {
  let errId: number | undefined;
  for (;;) {
    let videoId: number | undefined;
    if (opts.video) {
      try {
        videoId = (await ctx.replyWithVideo(opts.video)).message_id;
      } catch {
        /* file_id недоступен */
      }
    }
    const promptMsg = await ctx.reply(opts.prompt);
    const answer = await conversation.waitFor('message:text');
    const text = answer.message!.text.trim();

    if (videoId) await del(ctx, videoId);
    await del(ctx, promptMsg.message_id);
    await del(ctx, answer.message!.message_id);
    if (errId !== undefined) {
      await del(ctx, errId);
      errId = undefined;
    }

    if (opts.validate(text)) return text;
    errId = (await ctx.reply(opts.errorMsg)).message_id;
  }
}

// Диалог онбординга: IP → root-пароль → токен бота-продавца, с проверками и чистотой чата.
export async function onboarding(conversation: MyConversation, ctx: MyContext) {
  const ip = await askStep(conversation, ctx, {
    video: config.videos.ip,
    prompt: '1️⃣ Пришли IP-адрес сервера (в панели OneDash, вида 123.45.67.89):',
    validate: isValidIpv4,
    errorMsg: '❌ Это не похоже на IP. Пример: 123.45.67.89. Пришли ещё раз:',
  });

  const rootPassword = await askStep(conversation, ctx, {
    video: config.videos.password,
    prompt: '2️⃣ Пришли root-пароль сервера (из панели OneDash или письма).\n⚠️ Хранится зашифрованно.',
    validate: isNonEmptySecret,
    errorMsg: '❌ Пароль пустой или слишком короткий. Пришли ещё раз:',
  });

  const sellerToken = await askStep(conversation, ctx, {
    video: config.videos.token,
    prompt:
      '3️⃣ Пришли токен твоего бота-продавца.\n' +
      'Создай бота: @BotFather → /newbot → скопируй строку вида 123456:AA...',
    validate: isValidBotToken,
    errorMsg: '❌ Это не похоже на токен бота. Пример: 123456789:AAH... Пришли ещё раз:',
  });

  const from = ctx.from!;
  const id = await conversation.external(() =>
    insertNode({
      tgUserId: from.id,
      tgUsername: from.username,
      serverIp: ip,
      rootPasswordEnc: encrypt(rootPassword),
      sellerTokenEnc: encrypt(sellerToken),
    }),
  );

  const kb = new InlineKeyboard().text('🚀 Поднять VPN', `provision:${id}`);
  await ctx.reply(
    `✅ Данные приняты (сервер ${ip}).\nЖми «Поднять VPN» — я всё настрою сам.`,
    { reply_markup: kb },
  );
}
