import type { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { InlineKeyboard, type Context } from 'grammy';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { convertToBusiness, demoteNode, findNodeByIpOfOtherUser, findNodeByUserAndIp, getAllNodes, getNodeById, getLatestFailedSecondary, getPrimaryNodeAny, getPrimaryReadyNode, setNodePassword, setReplacedNodeId, setSellerTokenForUser, upsertNode, type NodeProtocol, type NodeRow } from './db.js';
import { parseProtocolCallback, protocolKeyboard, protocolLabel, protocolQuestion } from './protocols.js';
import { notifyAdmins } from './admin.js';
import { logEvent, type FunnelStep, type SideStep } from './events.js';
import { checkSshLogin, checkSshPort, preflightMessage } from './preflight.js';
import { checkTelegramFromServer, telegramBlockedMessage } from './tg-reach.js';
import { verifyBotToken } from './bot-token.js';
import { acceptTerms, hasAcceptedTerms, TERMS_ACCEPT_CALLBACK, TERMS_SHORT, TERMS_VERSION } from './terms.js';
import { updateSellerToken } from './deploy-seller.js';
import { checkIp, extractIpv4, ipProblemMessage, isNonEmptySecret, isValidBotToken, notIpMessage } from './validate.js';
import { clearSecretWait, markSecretWait, type SecretKind } from './chat-log.js';
import { getUserMode, setUserMode, UPGRADE_INTRO } from './personal.js';
import { kvGet } from './kv.js';

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
    /** attempt — сколько раз уже отказали на этом шаге (0 — первая попытка). */
    validate: (s: string, attempt: number) => string | null;
    onReject?: (input: string) => Promise<void>;
    /** Привести ввод к делу до проверки (например, вытащить IP из «root@1.2.3.4:22»). */
    normalize?: (s: string) => string;
    /** Ответ на этом шаге — секрет: в журнал диалога он не попадёт (см. chat-log.ts). */
    secret?: SecretKind;
  },
): Promise<string> {
  let errId: number | undefined;
  let attempt = 0;
  const uid = ctx.from!.id;
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
    if (opts.secret) await conversation.external(() => markSecretWait(uid, opts.secret!));
    const answer = await conversation.waitFor('message:text');
    if (opts.secret) await conversation.external(() => clearSecretWait(uid));
    const raw = answer.message!.text.trim();
    const text = opts.normalize ? opts.normalize(raw) : raw;

    if (videoId) await del(ctx, videoId);
    await del(ctx, promptMsg.message_id);
    await del(ctx, answer.message!.message_id);
    if (errId !== undefined) {
      await del(ctx, errId);
      errId = undefined;
    }

    const err = opts.validate(text, attempt);
    if (err === null) return text;
    attempt++;
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
    normalize: (s) => extractIpv4(s) ?? s,
    validate: (s, attempt) => {
      const problem = checkIp(s);
      if (problem === 'not_ip') return notIpMessage(s, attempt + 1);
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
    if (config.supportBotToken) kb.row().url('🆘 Поддержка', config.supportBotUrl + '?start=preflight');
    await ctx.api
      .editMessageText(ctx.chat!.id, statusMsg.message_id, preflightMessage(ip, res.reason), { reply_markup: kb })
      .catch(() => {});

    const upd = await conversation.wait();
    const data = upd.callbackQuery?.data;
    if (data) await upd.answerCallbackQuery().catch(() => {});

    if (data === 'pf:new' || (!data && upd.message?.text)) {
      // «Другой IP» или человек просто прислал новый адрес сообщением
      await track('newip_click');
      const rawTyped = upd.message?.text?.trim();
      const typed = rawTyped ? (extractIpv4(rawTyped) ?? rawTyped) : undefined;
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
//
// 07.11: по просьбе автора франшизы выбор протокола вернули (WS+TLS / Reality / AmneziaWG) —
// см. protocols.ts. WS+TLS остаётся первым и рекомендуемым, остальные — осознанный выбор
// владельца с честным описанием на кнопке; решение 08.09 про причину не отменено.

async function askProtocol(conversation: MyConversation, ctx: MyContext, track: Track): Promise<NodeProtocol> {
  const q = await ctx.reply(protocolQuestion(), { reply_markup: protocolKeyboard() });
  for (;;) {
    const upd = await conversation.waitForCallbackQuery(/^proto:/);
    await upd.answerCallbackQuery().catch(() => {});
    const chosen = parseProtocolCallback(upd.callbackQuery.data);
    if (!chosen) continue;
    await del(ctx, q.message_id);
    await track('protocol_chosen', chosen);
    return chosen;
  }
}

// Спрашивает root-пароль УЖЕ заведённого сервера и сверяет его с самим сервером.
// Возвращает пароль, который сервер принял (или который не удалось проверить из-за сети —
// тогда человека не держим, решит установка, как и в основном потоке).
async function askVerifiedPassword(
  conversation: MyConversation,
  ctx: MyContext,
  host: string,
  prompt: string,
): Promise<string> {
  let p = prompt;
  for (;;) {
    const pw = await askStep(conversation, ctx, {
      video: '',
      prompt: p,
      secret: 'password',
      validate: (s) => (isNonEmptySecret(s) ? null : '❌ Пароль пустой или слишком короткий. Пришли ещё раз:'),
    });
    const checking = await ctx.reply('🔐 Проверяю пароль на сервере…');
    const verdict = await conversation.external(() => checkSshLogin(host, pw));
    await del(ctx, checking.message_id);
    if (verdict !== 'bad_password') return pw;
    p =
      '❌ Сервер не принял и этот пароль. Нужен root-пароль именно этого сервера: он в письме от ' +
      'хостинга и в панели, в карточке сервера (там же его можно сбросить).\n\nПришли ещё раз:';
  }
}

// 🔴 07.11 (обращение #14): основной сервер владельца перестал пускать станок (переустановка,
// смена пароля), а станок про это не знал и писал «пришли данные нового сервера» по кругу.
// Отдельный короткий путь: обновить пароль основного, не трогая остальное.
export async function updatePrimaryPassword(conversation: MyConversation, ctx: MyContext) {
  const from = ctx.from!;
  const track: Track = (step, detail) =>
    conversation.external(() => logEvent({ id: from.id, username: from.username }, step, detail));
  const primary = await conversation.external(() => getPrimaryNodeAny(from.id));
  if (!primary) {
    await ctx.reply('У тебя ещё нет основного сервера — нажми /start, настроим с нуля.');
    return;
  }
  const pw = await askVerifiedPassword(
    conversation,
    ctx,
    primary.server_ip,
    `🔑 Пришли актуальный root-пароль основного сервера ${primary.server_ip}.\n` +
      'Он в панели хостинга, в карточке сервера (там же можно сбросить). ⚠️ Хранится зашифрованно.',
  );
  await conversation.external(() => setNodePassword(primary.id, encrypt(pw)));
  await track('primary_password_updated', `узел #${primary.id}`);
  const failed: NodeRow | undefined = await conversation.external(() => getLatestFailedSecondary(from.id));
  const kb = failed ? new InlineKeyboard().text(`🔄 Добавить сервер ${failed.server_ip} снова`, `provision:${failed.id}`) : undefined;
  await ctx.reply(
    '✅ Пароль основного сервера обновлён.' +
      (failed ? '\n\nМожно добавлять сервер заново — вводить ничего не нужно.' : ''),
    kb ? { reply_markup: kb } : undefined,
  );
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

  // 17.11: «свой VPN для себя» (personal.ts) — тот же путь без условий для владельцев ботов,
  // без токена @BotFather и без бота-продавца. Режим выбран на первом экране и лежит в kv.
  const personal = (await conversation.external(() => getUserMode(from.id))) === 'personal';

  const primary = await conversation.external(() => getPrimaryReadyNode(from.id));
  // Последний primary этого владельца НЕЗАВИСИМО от статуса — нужен ниже, чтобы
  // отличить «умер, это его замена» от «жив, это вторая точка» без переспросов.
  const primaryAny = await conversation.external(() => getPrimaryNodeAny(from.id));

  // 22.10: до первого шага человек видит условия и принимает их. Принявший раньше (в рассылке
  // или при прошлой настройке) этого экрана не видит.
  // Условия написаны для владельцев ботов (клиенты, реклама франшизы, простой бота) — к личному
  // VPN они не относятся; их покажем, если человек позже подключит бота (upgradePersonal).
  if (!personal && !(await conversation.external(() => hasAcceptedTerms(from.id)))) {
    const kb = new InlineKeyboard().text('✅ Принимаю', TERMS_ACCEPT_CALLBACK);
    await ctx.reply(TERMS_SHORT, { reply_markup: kb });
    const upd = await conversation.waitForCallbackQuery(TERMS_ACCEPT_CALLBACK);
    await upd.answerCallbackQuery().catch(() => {});
    await conversation.external(() => acceptTerms(from.id));
    await track('terms_accepted', TERMS_VERSION);
  }

  const ip = await ipThatAnswers(conversation, ctx, from.id, track);

  // Личный режим на сервере, который у этого же человека уже работает в бизнесе, разжаловал бы
  // узел бизнеса (upsertNode по паре «человек + IP») — бот или его точка выпали бы из учёта.
  if (personal) {
    const same = await conversation.external(() => findNodeByUserAndIp(from.id, ip));
    // Только РАБОТАЮЩИЙ бизнес-узел: недоделанная попытка бизнеса на этом сервере (передумал
    // и выбрал «для себя») спокойно становится личным.
    if (same && same.mode === 'business' && same.status === 'ready') {
      await ctx.reply(
        `Сервер ${ip} уже работает в твоём VPN-бизнесе — свой VPN бери прямо в боте: ` +
          'открой бота → /start → «🆓 Мой VPN».\n\nДля отдельного личного VPN нужен другой сервер.',
      );
      return;
    }
  }

  const protocol = await askProtocol(conversation, ctx, track);

  // 🔴 07.11 (#14): прежде чем просить пароль НОВОГО сервера, убеждаемся, что станок ещё
  // пускает на ОСНОВНОЙ. Раньше это всплывало только после установки на новый сервер, а
  // человеку говорили, что виноват новый — и он ходил по кругу.
  let primaryGone = false;
  if (!personal && primary && primary.server_ip !== ip) {
    const storedPw = decrypt(primary.root_password_enc);
    const pv = await conversation.external(() => checkSshLogin(primary.server_ip, storedPw));
    if (pv === 'bad_password') {
      await track('primary_password_bad', primary.server_ip);
      const kbp = new InlineKeyboard()
        .text('🔑 Пришлю новый пароль основного', 'pw_new')
        .row()
        .text('🗑 Основного сервера больше нет', 'pw_gone');
      await ctx.reply(
        `⚠️ Твой основной сервер (${primary.server_ip}, где работает бот) больше не принимает сохранённый у меня пароль — ` +
          'похоже, его сменили или систему там переустановили.\n\nЧто из этого?',
        { reply_markup: kbp },
      );
      const ans = await conversation.waitForCallbackQuery(['pw_new', 'pw_gone']);
      await ans.answerCallbackQuery().catch(() => {});
      if (ans.callbackQuery.data === 'pw_gone') {
        primaryGone = true;
        await track('primary_gone', primary.server_ip);
      } else {
        const fresh = await askVerifiedPassword(
          conversation,
          ctx,
          primary.server_ip,
          `🔑 Пришли актуальный root-пароль основного сервера ${primary.server_ip}.\n⚠️ Хранится зашифрованно.`,
        );
        await conversation.external(() => setNodePassword(primary.id, encrypt(fresh)));
        await track('primary_password_updated', `узел #${primary.id}`);
      }
    }
  }

  // Пароль проверяем на сервере сразу, а не после «Поднять VPN» (см. preflight.ts::checkSshLogin).
  let passwordPrompt =
    '2️⃣ Пришли root-пароль сервера.\n' +
    'Он в письме от хостинга после покупки и в панели, в карточке сервера. Копируй целиком, без пробелов по краям.\n' +
    '⚠️ Хранится зашифрованно.';
  let rootPassword: string;
  for (;;) {
    rootPassword = await askStep(conversation, ctx, {
      video: config.videos.password,
      prompt: passwordPrompt,
      secret: 'password',
      validate: (s) =>
        isNonEmptySecret(s) ? null : '❌ Пароль пустой или слишком короткий. Пришли ещё раз:',
    });
    const checking = await ctx.reply('🔐 Проверяю пароль на сервере…');
    const pw = rootPassword;
    const verdict = await conversation.external(() => checkSshLogin(ip, pw));
    await del(ctx, checking.message_id);
    if (verdict !== 'bad_password') break;
    await track('password_wrong'); // сам пароль в журнал не попадает — только факт
    passwordPrompt =
      '❌ Сервер не принял этот пароль.\n\n' +
      'Частые причины: скопирован с лишним символом, взят от личного кабинета хостинга, а не от сервера, ' +
      'или сервер переустанавливали — тогда пароль новый. Нужен именно root-пароль сервера: ' +
      'он в письме после покупки и в панели, в карточке сервера. Если не найти — там же можно его сбросить.\n\n' +
      'Пришли root-пароль ещё раз:';
  }
  await track('password_ok'); // сам пароль в журнал не попадает — только факт

  if (personal) {
    // Ни токена, ни проверки Telegram с сервера (бота там не будет). Узел не primary: всё, что
    // обслуживает ботов-продавцов (монитор токенов, бэкапы, рассылки), его не трогает.
    // seller_token_enc в таблице NOT NULL — кладём зашифрованную пустую строку.
    const pid = await conversation.external(() =>
      upsertNode({
        tgUserId: from.id,
        tgUsername: from.username,
        serverIp: ip,
        rootPasswordEnc: encrypt(rootPassword),
        sellerTokenEnc: encrypt(''),
        isPrimary: false,
        protocol,
        mode: 'personal',
      }),
    );
    await ctx.reply(
      `✅ Данные приняты (сервер ${ip}).\nЖми «Поднять VPN» — я всё настрою сам и через пару минут пришлю твой ключ.`,
      { reply_markup: new InlineKeyboard().text(`🚀 Поднять VPN (${protocolLabel(protocol)})`, `provision:${pid}`) },
    );
    return;
  }

  // 🔴 22.10: бот-продавец живёт на этом сервере и работает через Telegram. Если хостер режет
  // Telegram (случай узла #36), бот запустится и будет молчать, а станок скажет «Готово».
  // Узнаём это сейчас, пока человек не отдал токен и не ждал установки. Только для основного
  // сервера: у дополнительной точки бота нет, ему Telegram не нужен. 'unknown' (не смогли
  // проверить) не блокирует — после запуска бота есть вторая проверка (deploy-seller.ts).
  if (!primary) {
    const pwNow = rootPassword;
    const tg = await conversation.external(() => checkTelegramFromServer(ip, pwNow));
    if (tg === 'blocked') {
      await track('telegram_blocked', `${ip} · до установки`);
      const blockedKb = new InlineKeyboard().text('🛒 Как купить сервер', 'buy');
      if (config.supportBotToken) blockedKb.row().url('🆘 Поддержка', config.supportBotUrl + '?start=telegram');
      await ctx.reply(telegramBlockedMessage(ip), { reply_markup: blockedKb });
      return;
    }
  }

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
  let isReplacement = primaryGone;
  if (primaryAny && !isResubmittedPrimary && !primaryGone) {
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

  const kb = new InlineKeyboard().text(`🚀 Поднять VPN (${protocolLabel(protocol)})`, `provision:${id}`);
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

// 17.11: «Зарабатывать на этом сервере» — личный VPN владельца становится бизнесом: на тот же
// сервер ставим бота-продавца. Спрашиваем только то, чего не хватает: согласие с условиями для
// владельцев ботов и токен. IP и пароль уже есть, VPN не переустанавливается (install-скрипты
// идемпотентны и отдают тот же первый ключ — личный ключ владельца продолжает работать).
// Номер узла кладёт обработчик кнопки в kv (`upgrade:<id человека>`): conversations v1 не
// передаёт аргументы в enter().
export async function upgradePersonal(conversation: MyConversation, ctx: MyContext) {
  const from = ctx.from!;
  const track: Track = (step, detail) =>
    conversation.external(() => logEvent({ id: from.id, username: from.username }, step, detail));

  const nodeId = Number(await conversation.external(() => kvGet(`upgrade:${from.id}`)));
  const node: NodeRow | undefined = await conversation.external(() => getNodeById(nodeId));
  if (!node || node.tg_user_id !== from.id || node.mode !== 'personal') {
    await ctx.reply('Не нашёл твой личный сервер. Нажми /start — настроим с нуля.');
    return;
  }
  // Бот у человека уже есть — второй бот на тот же аккаунт не ставим (409, см. фикс 25.08):
  // этот сервер можно добавить в существующего бота точкой через обычный путь.
  const primaryAny = await conversation.external(() => getPrimaryNodeAny(from.id));
  if (primaryAny) {
    await ctx.reply(
      'У тебя уже есть бот-продавец — второй ставить не нужно. Этот сервер можно добавить в него ' +
        'ещё одной точкой: /start → «💰 VPN-бизнес» → «Я уже купил сервер» и пришли этот же IP.',
    );
    return;
  }
  await track('personal_upgrade', `узел #${node.id}`);
  await ctx.reply(UPGRADE_INTRO);

  if (!(await conversation.external(() => hasAcceptedTerms(from.id)))) {
    const kb = new InlineKeyboard().text('✅ Принимаю', TERMS_ACCEPT_CALLBACK);
    await ctx.reply(TERMS_SHORT, { reply_markup: kb });
    const upd = await conversation.waitForCallbackQuery(TERMS_ACCEPT_CALLBACK);
    await upd.answerCallbackQuery().catch(() => {});
    await conversation.external(() => acceptTerms(from.id));
    await track('terms_accepted', TERMS_VERSION);
  }

  // Бот живёт на этом сервере и ходит в Telegram — если хостер его режет, узнаём до токена.
  const pw = decrypt(node.root_password_enc);
  const tg = await conversation.external(() => checkTelegramFromServer(node.server_ip, pw));
  if (tg === 'blocked') {
    await track('telegram_blocked', `${node.server_ip} · перед подключением бота к личному VPN`);
    await ctx.reply(telegramBlockedMessage(node.server_ip));
    return;
  }

  const token = await askWorkingToken(
    conversation,
    ctx,
    track,
    from.id,
    '🔑 Пришли токен твоего бота-продавца.\n' + 'Создай бота: @BotFather → /newbot → скопируй строку вида 123456:AA...',
  );
  await conversation.external(() => {
    convertToBusiness(node.id, encrypt(token));
    setUserMode(from.id, 'business');
  });
  await track('mode_chosen', 'business · из личного');
  await ctx.reply('✅ Токен принят. Жми «Поднять бота» — поставлю его на этот же сервер, личный ключ не изменится.', {
    reply_markup: new InlineKeyboard().text('🚀 Поднять бота', `provision:${node.id}`),
  });
}
