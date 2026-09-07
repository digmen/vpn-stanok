import type { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { InlineKeyboard, type Context } from 'grammy';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { demoteNode, findNodeByIpOfOtherUser, getAllNodes, getPrimaryNodeAny, getPrimaryReadyNode, setReplacedNodeId, setSellerTokenForUser, upsertNode } from './db.js';
import { notifyAdmins } from './admin.js';
import { logEvent, type FunnelStep, type SideStep } from './events.js';
import { checkSshPort, preflightMessage } from './preflight.js';
import { verifyBotToken } from './bot-token.js';
import { updateSellerToken } from './deploy-seller.js';
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

// Спрашивает токен, пока не пришлют ТАКОЙ, который реально принимает Telegram.
//
// 🔴 07.09: раньше проверялся только формат строки (`isValidBotToken`) — синтаксически годный,
// но отозванный токен проходил насквозь, разворачивался на сервер и там падал в вечный
// цикл перезапусков (см. bot-token.ts, инцидент с 2333 рестартами). Теперь формат — только
// первый фильтр, а решает живой ответ getMe.
/** Есть ли уже ДРУГОЙ владелец с этим же токеном. Сравнивать шифротексты нельзя (каждый
 *  раз новый IV — одинаковые токены дают разные строки), поэтому расшифровываем и сравниваем
 *  открытые значения. Узлов десятки, не тысячи — дешевле, чем хранить хэш отдельной колонкой. */
function ownerOfToken(token: string, exceptTgUserId: number): number | null {
  for (const n of getAllNodes()) {
    if (n.tg_user_id === exceptTgUserId) continue;
    try {
      if (decrypt(n.seller_token_enc) === token) return n.tg_user_id;
    } catch {
      /* запись зашифрована другим ключом или битая — пропускаем, это не совпадение */
    }
  }
  return null;
}

async function askWorkingToken(
  conversation: MyConversation,
  ctx: MyContext,
  track: Track,
  tgUserId: number,
  firstPrompt: string,
): Promise<string> {
  let prompt = firstPrompt;
  for (;;) {
    const token = await askStep(conversation, ctx, {
      video: config.videos.token,
      prompt,
      validate: (s) =>
        isValidBotToken(s) ? null : '❌ Это не похоже на токен бота. Пример: 123456789:AAH... Пришли ещё раз:',
    });

    // Чужой токен: два процесса с одним токеном дерутся за getUpdates (409 Conflict) и
    // валят друг друга — в этом проекте так уже ломались боты дважды (25.08, Германия и
    // Амстердам). Тогда причиной был свой же второй сервер, но человек может прислать и
    // чужой токен (списал из инструкции/видео) — эффект тот же, ловим здесь.
    const takenBy = await conversation.external(() => ownerOfToken(token, tgUserId));
    if (takenBy) {
      await track('token_taken');
      prompt =
        '❌ Этот токен уже используется другим ботом в системе — скорее всего он списан из ' +
        'инструкции или чужого видео.\n\nЗаведи своего бота: @BotFather → /newbot — и пришли ' +
        'его токен:';
      continue;
    }

    const verdict = await conversation.external(() => verifyBotToken(token));
    // Сеть моргнула — это не вина человека и не приговор токену: берём как есть,
    // дальше его всё равно проверит провижининг перед установкой.
    if (verdict.ok || verdict.reason === 'network') {
      await track('token_ok');
      return token;
    }
    await track('token_invalid');
    prompt =
      '❌ Telegram не принимает этот токен (отвечает «Unauthorized»).\n\n' +
      'Скорее всего он уже перевыпущен. Возьми актуальный: @BotFather → /mybots → твой бот → ' +
      '«API Token» — и пришли сюда:';
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

// РЕШЕНИЕ 06.09: AmneziaWG новым узлам больше не предлагаем вообще — только
// VLESS+Reality. Заведённая 05.09 кнопка выбора (AmneziaWG/VLESS+Reality)
// снята: пока был выбор, это была честная развилка «обычный путь vs
// эксперимент», но раз VLESS+Reality теперь единственный путь для новых
// узлов — спрашивать нечего, лишний шаг в онбординге. Существующие узлы,
// заведённые ДО этого решения, остаются на своём протоколе как есть — их
// никто не переустанавливает (см. nodes.protocol DEFAULT 'amneziawg', эта
// колонка и вся ветка выбора скрипта в provision.ts никуда не делись, они
// продолжают обслуживать старые узлы).
// 🔴 РЕШЕНИЕ 08.09: новым узлам ставим VLESS+WS+TLS, а не Reality. Повод не теоретический:
// владелец узла #19 (Грозный, Vainah Telecom) не мог пользоваться своим же VPN — по логам
// xray было видно, что соединение доходит и мелкие пакеты идут, а поток данных оператор
// душит в ноль. Так вело себя Reality и через релей, и напрямую на 443, то есть дело было
// не в порту. Тот же путь на обычном TLS+WebSocket заработал сразу: 25 Мбит/с по Wi-Fi,
// 144 Мбит/с на мобильном. Причина понятная: Reality ПОДДЕЛЫВАЕТ чужое рукопожатие, и
// достаточно строгий оператор это ловит, а тут свой домен и свой валидный сертификат —
// снаружи неотличимо от обычного сайта, потому что это и есть обычный сайт.
// Узлы, заведённые ДО этого решения, остаются на своём протоколе (nodes.protocol), их
// никто не переустанавливает — миграция отдельной командой.
const NEW_NODE_PROTOCOL: 'vless_ws_tls' = 'vless_ws_tls';

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
// Отдельный, короткий путь «у меня перевыпущен токен» — без повторного онбординга.
// Владельцу не нужно заново вводить IP и пароль: сервер уже настроен, меняется одна строка
// в .env бота-продавца и процесс перезапускается (см. deploy-seller.ts::updateSellerToken).
//
// 🔴 07.09: заведено вместе с проверкой токена. Раньше такого пути не было вообще — человек
// с отозванным токеном оставался с молчащим ботом и ничего не мог сделать сам.
export async function updateToken(conversation: MyConversation, ctx: MyContext) {
  const from = ctx.from!;
  const track: Track = (step, detail) =>
    conversation.external(() => logEvent({ id: from.id, username: from.username }, step, detail));

  // 🔴 Намеренно `getPrimaryNodeAny`, а НЕ `getPrimaryReadyNode`: смена токена не должна
  // зависеть от того, в каком состоянии сейчас узел. Именно в состоянии 'error' (установка
  // не доехала как раз из-за мёртвого токена) она и нужна больше всего — а проверка на
  // 'ready' закрыла бы человеку единственный выход. Токен не должен зависеть ни от кэша,
  // ни от внутреннего состояния станка.
  const primary = await conversation.external(() => getPrimaryNodeAny(from.id));
  if (!primary) {
    await ctx.reply(
      'У тебя ещё нет ни одной заявки на сервер — токен пока некуда записывать.\n' +
        'Нажми /start, я проведу по шагам.',
    );
    return;
  }

  const token = await askWorkingToken(
    conversation,
    ctx,
    track,
    from.id,
    '🔑 Пришли новый токен бота-продавца.\n' +
      'Взять его: @BotFather → /mybots → твой бот → «API Token».',
  );

  // Сохраняем СРАЗУ, до попытки применить на сервере. Даже если сервер сейчас недоступен,
  // новый токен уже в базе — им воспользуется ближайшая установка. Так смена токена не может
  // «сломаться на полпути» и оставить человека со старым мёртвым значением.
  await conversation.external(() => setSellerTokenForUser(from.id, encrypt(token)));
  await track('token_updated', `сохранён, узел #${primary.id}`);

  const status = await ctx.reply('⚙️ Применяю новый токен и перезапускаю бота…');
  try {
    await conversation.external(() =>
      updateSellerToken(primary.server_ip, decrypt(primary.root_password_enc), token),
    );
    const verdict = await conversation.external(() => verifyBotToken(token));
    const kb =
      verdict.ok && verdict.username
        ? new InlineKeyboard().url('🚀 Открыть моего бота', `https://t.me/${verdict.username}`)
        : undefined;
    await ctx.api
      .editMessageText(ctx.chat!.id, status.message_id, '✅ Готово — бот снова работает. Проверь: напиши ему /start.', {
        reply_markup: kb,
      })
      .catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await track('token_update_fail', msg.slice(0, 150));
    await conversation.external(() =>
      notifyAdmins(
        ctx.api,
        `🔑 Узел #${primary.id} (${primary.server_ip}, @${from.username ?? from.id}): новый токен сохранён в базе, ` +
          `но применить его на сервере не вышло: ${msg.slice(0, 300)}`,
      ),
    );
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        status.message_id,
        '✅ Новый токен сохранён — старый больше нигде не используется.\n\n' +
          `⚠️ Но применить его прямо сейчас на сервере не получилось: ${msg.slice(0, 200)}\n\n` +
          'Похоже, сервер недоступен. Когда он оживёт — нажми /start → «Я купил сервер» → «Настроить», ' +
          'и я подниму бота уже с новым токеном. Заново вводить токен не придётся.',
      )
      .catch(() => {});
  }
}

export async function onboarding(conversation: MyConversation, ctx: MyContext) {
  const from = ctx.from!;
  const track: Track = (step, detail) =>
    conversation.external(() => logEvent({ id: from.id, username: from.username }, step, detail));

  const primary = await conversation.external(() => getPrimaryReadyNode(from.id));
  // Последний primary этого владельца НЕЗАВИСИМО от статуса — нужен ниже, чтобы
  // отличить «умер, это его замена» от «жив, это вторая точка» без переспросов.
  const primaryAny = await conversation.external(() => getPrimaryNodeAny(from.id));

  const ip = await ipThatAnswers(conversation, ctx, from.id, track);
  const protocol = NEW_NODE_PROTOCOL;

  const rootPassword = await askStep(conversation, ctx, {
    video: config.videos.password,
    prompt: '2️⃣ Пришли root-пароль сервера (из панели хостинга или письма).\n⚠️ Хранится зашифрованно.',
    validate: (s) =>
      isNonEmptySecret(s) ? null : '❌ Пароль пустой или слишком короткий. Пришли ещё раз:',
  });
  await track('password_ok'); // сам пароль в журнал не попадает — только факт

  // Токен бота-продавца у владельца всегда ОДИН (он один раз завёл его в BotFather) —
  // если уже видели хоть одну его заявку в primary, переспрашивать нечего, берём сохранённый.
  //
  // 🔴 07.09: но только если Telegram его ещё принимает. Пере-использование вслепую я завёл
  // этим же утром вместе с заменой primary — и в тот же вечер оно обернулось тупиком: у
  // Ramazan_LS токен был отозван, а прислать новый он физически не мог, станок молча брал
  // старый на каждой попытке. Сеть моргнула — не повод переспрашивать (reason 'network').
  let sellerToken: string;
  if (primaryAny) {
    const stored = decrypt(primaryAny.seller_token_enc);
    const verdict = await conversation.external(() => verifyBotToken(stored));
    if (verdict.ok || verdict.reason === 'network') {
      sellerToken = stored;
      await track('secondary_node');
    } else {
      await track('token_invalid', 'сохранённый токен отозван — прошу новый');
      sellerToken = await askWorkingToken(
        conversation,
        ctx,
        track,
        from.id,
        '🔑 Telegram больше не принимает токен твоего бота — его перевыпустили.\n\n' +
          'Возьми актуальный: @BotFather → /mybots → твой бот → «API Token» — и пришли сюда:',
      );
      // Сохраняем сразу: даже если человек бросит настройку на следующем шаге, новый рабочий
      // токен уже в базе, и следующая попытка не упрётся снова в мёртвый.
      await conversation.external(() => setSellerTokenForUser(from.id, encrypt(sellerToken)));
    }
  } else {
    sellerToken = await askWorkingToken(
      conversation,
      ctx,
      track,
      from.id,
      '3️⃣ Пришли токен твоего бота-продавца.\n' +
        'Создай бота: @BotFather → /newbot → скопируй строку вида 123456:AA...',
    );
  }

  // 🔴 29.08: баг живьём (узел #12) — юзер переприслал IP своего ЖЕ primary-сервера
  // (перезагрузка/переустановка у хостера снесла бота), и код молча разжаловал
  // единственную его запись в "secondary": `primary` тут вычислен ДО ввода IP и
  // остаётся truthy, даже если только что введённый IP — это IP того самого primary.
  // Секундарь не может быть primary-ом самому себе, поэтому его дальше некуда
  // приткнуть — provisionNode() требует ready-primary, а его только что стёрли.
  // Фикс: если IP совпал с IP уже существующего primary этого же юзера, это не
  // новый секундарь, а пересдача того же primary — и is_primary обязан остаться true.
  const isResubmittedPrimary = primaryAny?.server_ip === ip;

  // 🔴 07.09: баг живьём (Ramazan_LS, узел #18→#19) — хостер выдал совсем ДРУГОЙ IP
  // после пересоздания сервера (не тот же самый, тут isResubmittedPrimary не спасает),
  // а прошлый primary всё ещё числился 'ready' в базе. Код решил, что это ВТОРОЙ,
  // настоящий, доп. сервер — и попытался прикрепить его к первому (attachLocationToPrimary),
  // а тот на самом деле мёртв: EHOSTUNREACH при попытке зайти на него самого.
  // Фикс: если IP другой, а старый primary СЕЙЧАС физически недоступен (живая проверка,
  // не то что записано в status) — это не вторая точка, это замена умершего сервера.
  // Дальше работает как pesдача primary (is_primary=true), просто с другим IP; старый
  // узел снимаем с primary/ready, чтобы не путался под ногами и не пинговался монитором
  // вечно. Если старый primary НА САМОМ ДЕЛЕ жив — ничего не меняется, обычная вторая точка.
  let isReplacement = false;
  if (primaryAny && !isResubmittedPrimary) {
    const oldAlive = primary ? (await conversation.external(() => checkSshPort(primaryAny.server_ip))).ok : false;
    if (!oldAlive) isReplacement = true;
  }

  const id = await conversation.external(() =>
    upsertNode({
      tgUserId: from.id,
      tgUsername: from.username,
      serverIp: ip,
      rootPasswordEnc: encrypt(rootPassword),
      sellerTokenEnc: encrypt(sellerToken),
      isPrimary: !primaryAny || isResubmittedPrimary || isReplacement,
      protocol,
    }),
  );

  if (isReplacement && primaryAny) {
    await conversation.external(() => {
      demoteNode(primaryAny.id);
      setReplacedNodeId(id, primaryAny.id);
    });
    await track('primary_replaced', `${primaryAny.server_ip} → ${ip}`);
  }

  const kb = new InlineKeyboard().text('🚀 Поднять VPN', `provision:${id}`);
  await ctx.reply(
    isResubmittedPrimary
      ? `✅ Данные приняты (сервер ${ip}).\nЭто твой основной сервер — переустановлю бота на нём заново. ` +
          'Жми «Поднять VPN».'
      : isReplacement
        ? `✅ Данные приняты (сервер ${ip}).\nПрошлый твой сервер сейчас недоступен — считаю это его заменой: ` +
            'переустановлю бота на новом, а старые настройки (цены, локации) подтяну из бэкапа, если он есть. ' +
            'Жми «Поднять VPN».'
        : primaryAny
          ? `✅ Данные приняты (сервер ${ip}).\nЭто будет ещё одна точка в твоём уже работающем боте — ` +
              'отдельного бота заводить не нужно. Жми «Поднять VPN».'
          : `✅ Данные приняты (сервер ${ip}).\nЖми «Поднять VPN» — я всё настрою сам.`,
    { reply_markup: kb },
  );
}
