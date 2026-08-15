import type { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { InlineKeyboard, type Context } from 'grammy';
import { config } from './config.js';
import { encrypt } from './crypto.js';
import { findNodeByIpOfOtherUser, upsertNode } from './db.js';
import { checkSshPort, preflightMessage } from './preflight.js';
import { checkIp, ipProblemMessage, isNonEmptySecret, isValidBotToken } from './validate.js';

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
// validate возвращает текст ошибки или null, если ответ годится.
async function askStep(
  conversation: MyConversation,
  ctx: MyContext,
  opts: { video: string; prompt: string; validate: (s: string) => string | null },
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

    const err = opts.validate(text);
    if (err === null) return text;
    errId = (await ctx.reply(err)).message_id;
  }
}

// Спрашивает IP, пока не пришлют осмысленный: не пример из инструкции, не адрес за NAT
// и не сервер, уже занятый другим человеком.
async function askIp(conversation: MyConversation, ctx: MyContext, tgUserId: number): Promise<string> {
  return askStep(conversation, ctx, {
    video: config.videos.ip,
    // Пример специально не показываем: люди присылали его как свой (реальный случай — 123.45.67.88).
    prompt:
      '1️⃣ Пришли IP-адрес сервера.\n' +
      'Его видно в панели хостинга, в карточке твоего сервера — четыре числа через точку.',
    validate: (s) => {
      const problem = checkIp(s);
      if (problem) return ipProblemMessage(problem);
      const taken = findNodeByIpOfOtherUser(s.trim(), tgUserId);
      if (taken) {
        return (
          '❌ Этот сервер уже занят другим человеком. Похоже, адрес переписан из инструкции ' +
          'или из чужого видео.\n\nОткрой панель хостинга и пришли IP своего сервера:'
        );
      }
      return null;
    },
  });
}

// Проверяем доступность сервера ДО того, как просить пароль. Пока не отвечает — пароль не нужен.
async function ipThatAnswers(conversation: MyConversation, ctx: MyContext, tgUserId: number): Promise<string> {
  let ip = await askIp(conversation, ctx, tgUserId);
  const statusMsg = await ctx.reply(`🔍 Проверяю, отвечает ли сервер ${ip}…`);

  for (;;) {
    const res = await conversation.external(() => checkSshPort(ip));
    if (res.ok) {
      await ctx.api
        .editMessageText(ctx.chat!.id, statusMsg.message_id, `✅ Сервер ${ip} отвечает — продолжаем настройку.`)
        .catch(() => {});
      return ip;
    }

    const kb = new InlineKeyboard().text('🔄 Проверить снова', 'pf:retry').text('✏️ Другой IP', 'pf:new');
    await ctx.api
      .editMessageText(ctx.chat!.id, statusMsg.message_id, preflightMessage(ip, res.reason), { reply_markup: kb })
      .catch(() => {});

    const upd = await conversation.wait();
    const data = upd.callbackQuery?.data;
    if (data) await upd.answerCallbackQuery().catch(() => {});

    if (data === 'pf:new' || (!data && upd.message?.text)) {
      // «Другой IP» или человек просто прислал новый адрес сообщением
      const typed = upd.message?.text?.trim();
      if (typed && checkIp(typed) === null && !findNodeByIpOfOtherUser(typed, tgUserId)) {
        await del(ctx, upd.message!.message_id);
        ip = typed;
      } else {
        if (upd.message) await del(ctx, upd.message.message_id);
        ip = await askIp(conversation, ctx, tgUserId);
      }
    }
    // 'pf:retry' и всё прочее — просто пробуем тот же адрес ещё раз

    await ctx.api
      .editMessageText(ctx.chat!.id, statusMsg.message_id, `🔍 Проверяю, отвечает ли сервер ${ip}…`)
      .catch(() => {});
  }
}

// Диалог онбординга: IP → проверка связи → root-пароль → токен бота-продавца.
export async function onboarding(conversation: MyConversation, ctx: MyContext) {
  const from = ctx.from!;
  const ip = await ipThatAnswers(conversation, ctx, from.id);

  const rootPassword = await askStep(conversation, ctx, {
    video: config.videos.password,
    prompt: '2️⃣ Пришли root-пароль сервера (из панели хостинга или письма).\n⚠️ Хранится зашифрованно.',
    validate: (s) =>
      isNonEmptySecret(s) ? null : '❌ Пароль пустой или слишком короткий. Пришли ещё раз:',
  });

  const sellerToken = await askStep(conversation, ctx, {
    video: config.videos.token,
    prompt:
      '3️⃣ Пришли токен твоего бота-продавца.\n' +
      'Создай бота: @BotFather → /newbot → скопируй строку вида 123456:AA...',
    validate: (s) =>
      isValidBotToken(s) ? null : '❌ Это не похоже на токен бота. Пример: 123456789:AAH... Пришли ещё раз:',
  });

  const id = await conversation.external(() =>
    upsertNode({
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
