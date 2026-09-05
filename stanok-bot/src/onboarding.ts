import type { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { InlineKeyboard, type Context } from 'grammy';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { findNodeByIpOfOtherUser, getPrimaryReadyNode, upsertNode } from './db.js';
import { logEvent, type FunnelStep, type SideStep } from './events.js';
import { checkSshPort, preflightMessage } from './preflight.js';
import { checkIp, ipProblemMessage, isNonEmptySecret, isValidBotToken } from './validate.js';

export type MyContext = Context & ConversationFlavor;
export type MyConversation = Conversation<MyContext>;

// Пишет шаг в журнал ровно один раз: внутри разговора код проигрывается заново,
// а всё, что обёрнуто в conversation.external, повторно не выполняется.
type Track = (step: FunnelStep | SideStep, detail?: string) => Promise<void>;

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
  opts: {
    video: string;
    prompt: string;
    validate: (s: string) => string | null;
    onReject?: (input: string) => Promise<void>;
  },
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
    if (opts.onReject) await opts.onReject(text);
    errId = (await ctx.reply(err)).message_id;
  }
}

// Спрашивает IP, пока не пришлют осмысленный: не пример из инструкции, не адрес за NAT
// и не сервер, уже занятый другим человеком.
async function askIp(
  conversation: MyConversation,
  ctx: MyContext,
  tgUserId: number,
  track: Track,
): Promise<string> {
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
    onReject: async (input) => {
      const problem = checkIp(input);
      await (problem ? track('ip_rejected', problem) : track('ip_taken', input));
    },
  });
}

// Проверяем доступность сервера ДО того, как просить пароль. Пока не отвечает — пароль не нужен.
async function ipThatAnswers(
  conversation: MyConversation,
  ctx: MyContext,
  tgUserId: number,
  track: Track,
): Promise<string> {
  let ip = await askIp(conversation, ctx, tgUserId, track);
  await track('ip_ok', ip);
  const statusMsg = await ctx.reply(`🔍 Проверяю, отвечает ли сервер ${ip}…`);

  for (;;) {
    const res = await conversation.external(() => checkSshPort(ip));
    if (res.ok) {
      await track('preflight_ok', ip);
      await ctx.api
        .editMessageText(ctx.chat!.id, statusMsg.message_id, `✅ Сервер ${ip} отвечает — продолжаем настройку.`)
        .catch(() => {});
      return ip;
    }
    await track('preflight_fail', `${ip} · ${res.reason}`);

    const kb = new InlineKeyboard().text('🔄 Проверить снова', 'pf:retry').text('✏️ Другой IP', 'pf:new');
    await ctx.api
      .editMessageText(ctx.chat!.id, statusMsg.message_id, preflightMessage(ip, res.reason), { reply_markup: kb })
      .catch(() => {});

    const upd = await conversation.wait();
    const data = upd.callbackQuery?.data;
    if (data) await upd.answerCallbackQuery().catch(() => {});

    if (data === 'pf:new' || (!data && upd.message?.text)) {
      // «Другой IP» или человек просто прислал новый адрес сообщением
      await track('newip_click');
      const typed = upd.message?.text?.trim();
      if (typed && checkIp(typed) === null && !findNodeByIpOfOtherUser(typed, tgUserId)) {
        await del(ctx, upd.message!.message_id);
        ip = typed;
      } else {
        if (upd.message) await del(ctx, upd.message.message_id);
        ip = await askIp(conversation, ctx, tgUserId, track);
      }
      await track('ip_ok', ip);
    } else {
      await track('retry_click', ip);
    }

    await ctx.api
      .editMessageText(ctx.chat!.id, statusMsg.message_id, `🔍 Проверяю, отвечает ли сервер ${ip}…`)
      .catch(() => {});
  }
}

// Спрашивает протокол кнопками. Заведено 05.09 вместе с VLESS+Reality —
// до этого станок ставил только AmneziaWG, выбирать было не из чего.
// AmneziaWG — кнопка первой и с пометкой «обычный»: это протокол по умолчанию
// уже месяц в бою, VLESS+Reality — новый путь, без домена, честно подписан
// «эксперимент», чтобы не создавать впечатление проверенной альтернативы.
async function askProtocol(conversation: MyConversation, ctx: MyContext, track: Track): Promise<'amneziawg' | 'vless_reality'> {
  const kb = new InlineKeyboard()
    .text('🥷 AmneziaWG (обычный)', 'proto:amneziawg')
    .row()
    .text('🌀 VLESS+Reality (эксперимент, без домена)', 'proto:vless_reality');
  const msg = await ctx.reply(
    '0️⃣ Какой протокол поставить?\n\n' +
      '🥷 AmneziaWG — обычный путь, работает уже давно.\n' +
      '🌀 VLESS+Reality — маскируется под чужой настоящий сайт, держит обычную блокировку и ' +
      'блок UDP, но не переживает «белый список» (эксперимент, если не уверен — жми первую).',
    { reply_markup: kb },
  );

  for (;;) {
    const upd = await conversation.wait();
    const data = upd.callbackQuery?.data;
    if (data) await upd.answerCallbackQuery().catch(() => {});
    if (data === 'proto:amneziawg' || data === 'proto:vless_reality') {
      await del(ctx, msg.message_id);
      const protocol = data === 'proto:vless_reality' ? 'vless_reality' : 'amneziawg';
      await track('protocol_chosen', protocol);
      return protocol;
    }
    // Не та кнопка / текст мимо — переспрашиваем тем же сообщением, не плодим новые.
  }
}

// Диалог онбординга: IP → проверка связи → root-пароль → [токен бота-продавца, только
// если это ПЕРВЫЙ сервер владельца].
//
// 🔴 Общий фикс бага 25.08 (ловили дважды на живом клиенте, Германия и потом Амстердам):
// раньше шаг с токеном был ОБЯЗАТЕЛЬНЫМ всегда, и владелец, заводя ВТОРОЙ сервер, вводил
// тот же токен от того же бота (он-то один!) — станок послушно разворачивал ВТОРУЮ копию
// бота-продавца с тем же токеном, и они дрались за getUpdates (409 Conflict, crash-loop).
// Теперь: если у владельца уже есть готовый (ready) primary-узел — токен вообще не
// спрашиваем, а новый сервер после провижининга уходит не в deploySeller, а в
// attachLocationToPrimary (см. provision.ts) — становится ДОПОЛНИТЕЛЬНОЙ локацией внутри
// уже работающего бота, без второго процесса.
export async function onboarding(conversation: MyConversation, ctx: MyContext) {
  const from = ctx.from!;
  const track: Track = (step, detail) =>
    conversation.external(() => logEvent({ id: from.id, username: from.username }, step, detail));

  const primary = await conversation.external(() => getPrimaryReadyNode(from.id));

  const ip = await ipThatAnswers(conversation, ctx, from.id, track);
  const protocol = await askProtocol(conversation, ctx, track);

  const rootPassword = await askStep(conversation, ctx, {
    video: config.videos.password,
    prompt: '2️⃣ Пришли root-пароль сервера (из панели хостинга или письма).\n⚠️ Хранится зашифрованно.',
    validate: (s) =>
      isNonEmptySecret(s) ? null : '❌ Пароль пустой или слишком короткий. Пришли ещё раз:',
  });
  await track('password_ok'); // сам пароль в журнал не попадает — только факт

  // Уже есть бот → этот сервер просто добавит ему ещё одну точку выдачи VPN.
  // Токен НЕ спрашиваем — используем токен primary (он и так уже зашифрован в его
  // строке, отдельно этой записи не нужен, но колонка NOT NULL — переносим тот же).
  let sellerToken: string;
  if (primary) {
    sellerToken = decrypt(primary.seller_token_enc);
    await track('secondary_node');
  } else {
    sellerToken = await askStep(conversation, ctx, {
      video: config.videos.token,
      prompt:
        '3️⃣ Пришли токен твоего бота-продавца.\n' +
        'Создай бота: @BotFather → /newbot → скопируй строку вида 123456:AA...',
      validate: (s) =>
        isValidBotToken(s) ? null : '❌ Это не похоже на токен бота. Пример: 123456789:AAH... Пришли ещё раз:',
    });
    await track('token_ok');
  }

  // 🔴 29.08: баг живьём (узел #12) — юзер переприслал IP своего ЖЕ primary-сервера
  // (перезагрузка/переустановка у хостера снесла бота), и код молча разжаловал
  // единственную его запись в "secondary": `primary` тут вычислен ДО ввода IP и
  // остаётся truthy, даже если только что введённый IP — это IP того самого primary.
  // Секундарь не может быть primary-ом самому себе, поэтому его дальше некуда
  // приткнуть — provisionNode() требует ready-primary, а его только что стёрли.
  // Фикс: если IP совпал с IP уже существующего primary этого же юзера, это не
  // новый секундарь, а пересдача того же primary — и is_primary обязан остаться true.
  const isResubmittedPrimary = primary?.server_ip === ip;

  const id = await conversation.external(() =>
    upsertNode({
      tgUserId: from.id,
      tgUsername: from.username,
      serverIp: ip,
      rootPasswordEnc: encrypt(rootPassword),
      sellerTokenEnc: encrypt(sellerToken),
      isPrimary: !primary || isResubmittedPrimary,
      protocol,
    }),
  );

  const kb = new InlineKeyboard().text('🚀 Поднять VPN', `provision:${id}`);
  await ctx.reply(
    isResubmittedPrimary
      ? `✅ Данные приняты (сервер ${ip}).\nЭто твой основной сервер — переустановлю бота на нём заново. ` +
          'Жми «Поднять VPN».'
      : primary
        ? `✅ Данные приняты (сервер ${ip}).\nЭто будет ещё одна точка в твоём уже работающем боте — ` +
            'отдельного бота заводить не нужно. Жми «Поднять VPN».'
        : `✅ Данные приняты (сервер ${ip}).\nЖми «Поднять VPN» — я всё настрою сам.`,
    { reply_markup: kb },
  );
}
