import { Bot, InlineKeyboard, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { config } from './config.js';
import {
  getAllNodes,
  getNodeById,
  getNodesByUser,
  getReadyNodes,
  getBroadcastNodes,
  getReadyPrimaryNodes,
  setNodeBroadcast,
  getRevenueShareNodes,
  setNodeHealthOk,
  setRevenueSharePercent,
} from './db.js';
import { TOKEN_INVALID_HELP, verifyBotToken } from './bot-token.js';
import { stopSellerBot } from './deploy-seller.js';
import { onboarding, updateToken, type MyContext } from './onboarding.js';
import { provisionNode } from './provision.js';
import { notifyAdmins } from './admin.js';
import { checkNodeAlive } from './ssh.js';
import { hadRecentEvent, logEvent, userTimeline } from './events.js';
import { chatTranscript, clearSecretWait, logIncoming, logOutgoing, pruneChatLog, resolveUser } from './chat-log.js';
import { funnelReport } from './analytics.js';
import { runNudges } from './nudges.js';
import { buyGuideText } from './host-guide.js';
import { channelUrl, checkSubscribed, passedGate } from './channel.js';

/** Telegram режет сообщения на 4096 символах — длинные отчёты шлём кусками по строкам. */
function chunks(text: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > max && cur) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + (line.length > max ? line.slice(0, max) : line);
  }
  if (cur) out.push(cur);
  return out;
}
import { isValidBotToken } from './validate.js';
import { decrypt } from './crypto.js';
import { collectSetup, formatSetupReport } from './setup-report.js';
import { commission, revenueReport, syncNode } from './revenue.js';
import { backupAllPrimaries } from './backup.js';
import { broadcast, lastBroadcast, undoLast } from './broadcast.js';

const bot = new Bot<MyContext>(config.botToken);

// Журнал диалога (см. chat-log.ts): всё, что бот отправляет, и всё, что приходит.
// Трансформер ставится ДО старта — grammY копирует его в api каждого апдейта.
bot.api.config.use(logOutgoing);
bot.use(logIncoming);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// Команда посреди мастера настройки выводит из мастера.
// 🔴 13.09: раньше мастер съедал любое сообщение как ответ на свой шаг — /start на шаге IP
// получал «это не похоже на IP», и выхода из мастера не было вовсе, кроме как угадать
// правильный ответ. Люди так и уходили.
bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith('/')) {
    const active = await ctx.conversation.active();
    if (Object.keys(active).length > 0) await ctx.conversation.exit();
    if (ctx.from) clearSecretWait(ctx.from.id);
  }
  await next();
});

bot.use(createConversation(onboarding));
bot.use(createConversation(updateToken));

// ── Шаг 1: купить сервер ────────────────────────────────────────────────
function startKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🛒 Как купить сервер', 'buy')
    .row()
    .text('✅ Я уже купил сервер', 'bought');
  if (config.supportBotToken) kb.row().url('🆘 Поддержка', config.supportBotUrl + '?start=stanok');
  return kb;
}

const START_TEXT =
  'Привет! 👋\n\n' +
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

// Вход через подписку на канал (см. channel.ts). true — можно дальше. Иначе показали просьбу
// подписаться с кнопкой «Я подписался», которая вернёт человека ровно туда, куда он шёл (next).
let gateAlertAt = 0;
async function gate(ctx: MyContext, next: 'start' | 'bought' | 'setup'): Promise<boolean> {
  const from = ctx.from;
  if (!from || !config.channel || passedGate(from.id)) return true;
  const st = await checkSubscribed(ctx.api, from.id);
  if (st === 'yes') {
    logEvent(from, 'sub_ok');
    return true;
  }
  if (st === 'unknown') {
    // Станок не админ канала — не блокируем, но админу сообщаем (раз в сутки).
    logEvent(from, 'sub_unknown');
    if (Date.now() - gateAlertAt > 24 * 3600_000) {
      gateAlertAt = Date.now();
      void notifyAdmins(
        ctx.api,
        `📢 Не могу проверить подписку на ${config.channel}: станок не админ канала. Добавь @${ctx.me.username} ` +
          'в админы канала (права не нужны) — пока пропускаю всех без проверки.',
      );
    }
    return true;
  }
  logEvent(from, 'sub_prompt', next);
  await ctx.reply(
    '📢 Перед началом — подпишись на мой канал ' + config.channel + '.\n\n' +
      'Там я пишу, как устроен этот VPN, что нового в боте и что делать, если что-то сломалось.\n\n' +
      'Подписался — жми «Я подписался».',
    {
      reply_markup: new InlineKeyboard()
        .url('📢 Подписаться', channelUrl())
        .row()
        .text('✅ Я подписался', 'subcheck:' + next),
    },
  );
  return false;
}

bot.command('start', async (ctx) => {
  logEvent(ctx.from!, 'start');
  if (!(await gate(ctx, 'start'))) return;
  await ctx.reply(START_TEXT, { reply_markup: startKeyboard() });
});

bot.callbackQuery(/^subcheck:(start|bought|setup)$/, async (ctx) => {
  const next = ctx.match[1] as 'start' | 'bought' | 'setup';
  const st = await checkSubscribed(ctx.api, ctx.from.id);
  if (st === 'no') {
    logEvent(ctx.from, 'sub_fail');
    await ctx.answerCallbackQuery({ text: 'Пока не вижу подписки. Открой канал, нажми «Подписаться» и вернись сюда.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, st === 'yes' ? 'sub_ok' : 'sub_unknown');
  if (next === 'start') {
    await ctx.editMessageText(START_TEXT, { reply_markup: startKeyboard() }).catch(() => {});
  } else if (next === 'bought') {
    await showStep2(ctx);
  } else {
    await enterSetup(ctx);
  }
});

// Пошаговая покупка + бонусы хостинга (см. host-guide.ts). 'instr' — кнопка старых сообщений.
async function showBuyGuide(ctx: MyContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.from) logEvent(ctx.from, 'buy_open');
  if (config.videos.buy) {
    try {
      await ctx.replyWithVideo(config.videos.buy);
    } catch {
      /* file_id недоступен */
    }
  }
  await ctx.reply(buyGuideText(), {
    reply_markup: new InlineKeyboard()
      .url('🌐 Открыть хостинг', config.referralLink)
      .row()
      .text('✅ Я купил сервер', 'bought'),
  });
}
bot.callbackQuery('buy', showBuyGuide);
bot.callbackQuery('instr', showBuyGuide);

bot.callbackQuery('nudge_off', async (ctx) => {
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, 'nudge_off');
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  await ctx.reply('Хорошо, больше не напоминаю. Захочешь продолжить — /start.');
});

// ── Шаг 2: настроить ────────────────────────────────────────────────────
async function showStep2(ctx: MyContext): Promise<void> {
  const kb = new InlineKeyboard().text('⚙️ Настроить', 'setup');
  // Морфим то же сообщение в Шаг 2 — чат не засоряется
  await ctx.editMessageText(
    '📍 Шаг 2. Настройка сервера\n\n' +
      'Сейчас я попрошу дать доступ к серверу, чтобы настроить его в автоматическом режиме.\n\n' +
      'Мне нужны:\n' +
      '1. IP — сразу проверю, отвечает ли сервер\n' +
      '2. Пароль (спрошу, только если сервер отозвался)\n' +
      '3. Токен бота — его можно получить, создав бота через @BotFather\n\n' +
      'К каждому шагу буду давать инструкцию.\n\n' +
      'Жми «Настроить».',
    { reply_markup: kb },
  );
}

async function enterSetup(ctx: MyContext): Promise<void> {
  await ctx.deleteMessage().catch(() => {}); // убираем сообщение Шага 2, чтобы не висело
  // «Продолжить настройку» из напоминания может прийти, пока висит старый мастер.
  if (Object.keys(await ctx.conversation.active()).length > 0) await ctx.conversation.exit();
  await ctx.conversation.enter('onboarding');
}

// ── Шаг 2: настроить ────────────────────────────────────────────────────
bot.callbackQuery('bought', async (ctx) => {
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, 'bought_click');
  if (!(await gate(ctx, 'bought'))) return;
  await showStep2(ctx);
});

bot.callbackQuery('setup', async (ctx) => {
  await ctx.answerCallbackQuery();
  logEvent(ctx.from, 'setup_click');
  if (!(await gate(ctx, 'setup'))) return;
  await enterSetup(ctx);
});

// ── Провижининг: поднять VPN ────────────────────────────────────────────
bot.callbackQuery(/^provision:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const nodeId = Number(ctx.match[1]);
  logEvent(ctx.from, 'provision_click', String(nodeId));
  // Редактируем то же сообщение («Данные приняты»), а не плодим новые
  await provisionNode(ctx.api, ctx.chat!.id, nodeId, ctx.callbackQuery.message?.message_id);
});

// ── Служебное ───────────────────────────────────────────────────────────
bot.command('status', async (ctx) => {
  const nodes = getNodesByUser(ctx.from!.id);
  if (nodes.length === 0) {
    await ctx.reply('Заявок пока нет. Нажми /start и настрой сервер.');
    return;
  }
  const lines = nodes.map((n) => `#${n.id} · ${n.server_ip} · ${n.status}`).join('\n');
  await ctx.reply('Твои серверы:\n' + lines);
});

bot.command('help', async (ctx) => {
  const base = '/start — начать\n/status — статус твоих серверов\n/token — заменить токен бота-продавца';
  // Админские команды видит только админ — остальным они не нужны и только путают.
  const admin =
    '\n\n/say <текст> — рассылка владельцам (сначала покажу список получателей)' +
    '\n/undo — откатить последнюю рассылку' +
    '\n/nosay <id> — исключить узел из рассылок' +
    '\n/setup — как идёт настройка оплаты картой у владельцев и где они спотыкаются' +
    '\n/funnel [дней] — воронка: докуда дошли, кто ушёл и где, кто с первого раза' +
    '\n/chat @ник [строк] — диалог человека со станком в обе стороны';
  await ctx.reply(config.adminIds.includes(ctx.from?.id ?? -1) ? base + admin : base);
});

// Смена токена бота-продавца без повторной настройки сервера (см. onboarding.ts::updateToken).
bot.command('token', async (ctx) => {
  await ctx.conversation.enter('updateToken');
});

// Мониторинг всех узлов (только админ): статус + живая проверка доступности
// Где владельцы спотыкаются, настраивая оплату картой (только админ). Это не мониторинг,
// а материал для инструкций: «не работает» без деталей приходит к нам постоянно, а причина
// видна только в момент ошибки — см. setup-report.ts.
bot.command('setup', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const wait = await ctx.reply('Собираю с узлов…');
  const rows = await collectSetup();
  await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
  await ctx.reply(formatSetupReport(rows));
});

// Воронка (только админ): докуда дошли, кто ушёл и где, кто с первого раза (см. analytics.ts).
bot.command('funnel', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const days = Number((ctx.match ?? '').trim()) || 30;
  for (const part of chunks(funnelReport(days))) await ctx.reply(part);
});

// Диалог одного человека со станком (только админ): /chat @nick [строк].
// Журнал диалога ведётся с 13.09 — у тех, кто был раньше, показываем хотя бы шаги.
bot.command('chat', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const [who, n] = (ctx.match ?? '').trim().split(/\s+/);
  if (!who) {
    await ctx.reply('/chat @ник [сколько строк, по умолчанию 60]');
    return;
  }
  const id = resolveUser(who);
  if (!id) {
    await ctx.reply(`${who}: такого в журналах нет.`);
    return;
  }
  const rows = chatTranscript(id, Number(n) || 60);
  let text: string;
  if (rows.length > 0) {
    text =
      `💬 Диалог ${who} (👤 — он, 🤖 — бот):\n\n` +
      rows.map((r) => `${r.created_at.slice(5, 16)} ${r.dir === 'in' ? '👤' : '🤖'} ${r.text ?? ''}`).join('\n\n');
  } else {
    const steps = userTimeline(String(id));
    text =
      `${who}: диалога в журнале нет (он пишется с 13.09). Шаги:\n\n` +
      steps.map((s) => `${s.created_at.slice(5, 16)} ${s.step} ${s.detail ?? ''}`).join('\n');
  }
  for (const part of chunks(text)) await ctx.reply(part);
});

bot.command('nodes', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const nodes = getAllNodes();
  if (nodes.length === 0) {
    await ctx.reply('Узлов пока нет.');
    return;
  }
  const lines = await Promise.all(
    nodes.map(async (n) => {
      const health =
        n.status === 'ready'
          ? await checkNodeAlive(n.server_ip, decrypt(n.root_password_enc), !!n.is_primary, n.protocol)
          : { ok: false, detail: 'status ≠ ready' };
      return `#${n.id} ${health.ok ? '🟢' : '🔴'} ${n.server_ip} · ${n.status} · @${n.tg_username ?? '—'}${health.ok ? '' : ` · ${health.detail}`}`;
    }),
  );
  await ctx.reply('Узлы:\n' + lines.join('\n'));
});

// Выручка узлов (только админ). Основание для процента с продаж.
//
// 🔒 Узлы об этом не знают и знать не должны — сбор молчаливый, на их стороне
// ничего не меняется (см. revenue.ts). Команда админская: чужой /revenue
// просто игнорируется, как и /nodes.
bot.command('revenue', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const arg = (ctx.match ?? '').trim();

  // /revenue share <id> <percent|off> — включить/выключить долю на конкретном
  // узле. Единственное место, откуда это вообще берётся: по умолчанию НИ У
  // КОГО доли нет (см. миграция 06.09 в db.ts) — договорённость такого рода
  // заводится явно, руками, на того одного человека, с кем она реально есть.
  const shareMatch = arg.match(/^share\s+(\d+)\s+(off|\d{1,3})$/);
  if (shareMatch) {
    const nodeId = Number(shareMatch[1]);
    const node = getNodeById(nodeId);
    if (!node) {
      await ctx.reply(`Узла #${nodeId} нет.`);
      return;
    }
    if (shareMatch[2] === 'off') {
      setRevenueSharePercent(nodeId, null);
      await ctx.reply(`Доля с продаж для узла #${nodeId} выключена — станок его больше не трогает.`);
    } else {
      const percent = Number(shareMatch[2]);
      if (percent < 1 || percent > 100) {
        await ctx.reply('Процент — число от 1 до 100.');
        return;
      }
      setRevenueSharePercent(nodeId, percent);
      await ctx.reply(`Узел #${nodeId} (@${node.tg_username ?? node.server_ip}): включена доля ${percent}%.`);
    }
    return;
  }

  // `/revenue sync` идёт по серверам, но только по тем, где доля реально включена —
  // ходить в SSH к остальным читать их подписки не за чем и не по праву.
  if (arg === 'sync') {
    const wait = await ctx.reply('⏳ Обхожу узлы с включённой долей…');
    const nodes = getRevenueShareNodes();
    if (nodes.length === 0) {
      await ctx.api
        .editMessageText(ctx.chat.id, wait.message_id, 'Ни у одного узла не включена доля с продаж — обходить некого.')
        .catch(() => {});
      return;
    }
    const results = await Promise.all(nodes.map((n) => syncNode(n)));
    const failed = results.filter((r) => !r.ok);
    const added = results.reduce((s, r) => s + r.added, 0);
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        wait.message_id,
        `Готово. Узлов: ${results.length}, новых продаж: ${added}.` +
          (failed.length ? `\n\nНе ответили: ${failed.map((f) => `#${f.nodeId}`).join(', ')}` : ''),
      )
      .catch(() => {});
    return;
  }

  const rows = revenueReport();
  if (rows.length === 0) {
    await ctx.reply(
      'Ни у одного узла не включена доля с продаж — отчёту не по чему считать.\n\n' +
        '/revenue share <id> <процент|off> — включить/выключить на конкретном узле.',
    );
    return;
  }
  const lines = rows.map((r) => {
    const who = r.username ? '@' + r.username : r.serverIp;
    const week = r.weekStars > 0 ? `${r.weekStars} ⭐ (${r.weekCount})` : '—';
    return (
      `#${r.nodeId} ${who}\n` +
      `   за неделю: ${week} · твои ${r.sharePercent}%: ${commission(r.weekStars, r.sharePercent)} ⭐\n` +
      `   всего: ${r.totalStars} ⭐ за ${r.totalCount} продаж` +
      (r.trials ? ` · пробных ${r.trials}` : '')
    );
  });
  const weekTotal = rows.reduce((s, r) => s + r.weekStars, 0);
  const weekCommission = rows.reduce((s, r) => s + commission(r.weekStars, r.sharePercent), 0);
  await ctx.reply(
    lines.join('\n\n') +
      `\n\n💰 Итого за неделю: ${weekTotal} ⭐ · твои: ${weekCommission} ⭐` +
      '\n\n/revenue sync — обойти узлы прямо сейчас' +
      '\n/revenue share <id> <процент|off> — включить/выключить на узле',
  );
});

// Админ присылает медиа → бот возвращает file_id (чтобы вставить в .env как видео-инструкцию).
bot.on(['message:video', 'message:animation', 'message:document', 'message:photo'], async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const msg = ctx.message;
  const fileId =
    msg?.video?.file_id ??
    msg?.animation?.file_id ??
    msg?.document?.file_id ??
    msg?.photo?.at(-1)?.file_id;
  if (fileId) {
    await ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: 'HTML' });
  }
});

// Свободные сообщения в чате со станком — чтобы видеть, как люди на самом деле пользуются
// ботом (его просьба 07.09: «кажется, что люди не так пользуются моим ботом»). До 07.09
// в журнал попадали только шаги воронки, без единого слова человека — и понять, что он
// пытался сделать и где застрял, было нельзя.
//
// 🔒 Почему это не нарушает правило «в журнал не попадают секреты» (events.ts):
// обработчик стоит ПОСЛЕ мастера настройки, а мастер съедает сообщения своих шагов — то есть
// root-пароль и токен, которые вводят внутри мастера, сюда физически не доходят. Плюс страховка
// ниже: строку, похожую на токен бота, не пишем никогда, даже если она пришла вне мастера.
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return; // команды уже видны как отдельные шаги
  if (isValidBotToken(text)) return; // на всякий случай: токен в журнал не кладём никогда
  logEvent(ctx.from, 'chat_message', text.slice(0, 200));
});

// Рассылка владельцам узлов и откат последней рассылки.
//
// 🔴 08.09: заведено после того, как разосланное оповещение попросили удалить, а
// идентификаторы сообщений нигде не сохранялись — пришлось искать их перебором номеров,
// рискуя зацепить чужое сообщение. Теперь любая рассылка отменяется одной командой.
//
// В текст рассылки НЕ подставляем ничего от себя: ни номеров узлов, ни имён — уходит
// ровно то, что написал владелец станка. Раньше я дописывал в конец служебную строку
// с перечислением, кому ушло, и это лишнее в сообщении, которое человек может переслать.
// Черновик рассылки ждёт подтверждения. Живёт в памяти и недолго: рассылка — действие,
// которое нельзя «недоделать», и висящий сутками черновик опаснее потерянного.
let sayDraft: { text: string; targets: { id: number; label: string }[]; at: number } | null = null;
const SAY_TTL_MS = 600_000;

bot.command('say', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const text = ctx.match?.trim();
  if (!text) {
    await ctx.reply('Напиши текст после команды:\n/say Привет! Появились промокоды и скидки.');
    return;
  }
  const nodes = getBroadcastNodes();
  if (nodes.length === 0) {
    await ctx.reply('Некому рассылать: нет живых узлов, либо все исключены из рассылок.');
    return;
  }
  // Один владелец может держать несколько узлов — письмо ему нужно одно.
  const byOwner = new Map<number, string>();
  for (const n of nodes) {
    if (!byOwner.has(n.tg_user_id)) byOwner.set(n.tg_user_id, `#${n.id} @${n.tg_username ?? n.tg_user_id}`);
  }
  sayDraft = {
    text,
    targets: [...byOwner].map(([id, label]) => ({ id, label })),
    at: Date.now(),
  };

  // 🔴 08.09: показываем СПИСОК ПОЛУЧАТЕЛЕЙ до отправки. Раньше команда слала сразу, и
  // человек, которому рассылка была не нужна, получил её — увидели это уже постфактум.
  // Список видит только админ, в само сообщение он не попадает.
  const kb = new InlineKeyboard().text('✅ Отправить', 'saysend').text('❌ Отмена', 'saycancel');
  await ctx.reply(
    `📢 Получат (${sayDraft.targets.length}):\n` +
      sayDraft.targets.map((x) => '• ' + x.label).join('\n') +
      '\n\n─── текст ───\n' +
      text +
      '\n───\n\nПроверь список и текст. Отправляем?',
    { reply_markup: kb },
  );
});

bot.callbackQuery('saycancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  sayDraft = null;
  await ctx.editMessageText('❌ Рассылка отменена, никому ничего не ушло.').catch(() => {});
});

bot.callbackQuery('saysend', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  if (!sayDraft || Date.now() - sayDraft.at > SAY_TTL_MS) {
    sayDraft = null;
    await ctx.editMessageText('⌛ Черновик устарел — набери /say заново.').catch(() => {});
    return;
  }
  const draft = sayDraft;
  sayDraft = null;
  const { record, failed } = await broadcast(ctx.api, draft.targets.map((x) => x.id), draft.text);
  await ctx
    .editMessageText(
      `📢 Отправлено: ${record.sent.length} из ${draft.targets.length}` +
        (failed.length > 0 ? ` (не доставлено ${failed.length})` : '') +
        '\n\nПередумал — /undo, удалю у всех.',
    )
    .catch(() => {});
});

// Исключить владельца из рассылок или вернуть обратно: /nosay <id узла> [on]
bot.command('nosay', async (ctx) => {
  if (!config.adminIds.includes(ctx.from?.id ?? -1)) return;
  const m = (ctx.match ?? '').trim().match(/^(\d+)(\s+on)?$/);
  if (!m) {
    await ctx.reply('/nosay <id узла> — исключить из рассылок\n/nosay <id узла> on — вернуть обратно');
    return;
  }
  const id = Number(m[1]);
  const node = getNodeById(id);
  if (!node) {
    await ctx.reply(`Узла #${id} нет.`);
    return;
  }
  const allowed = Boolean(m[2]);
  setNodeBroadcast(id, allowed);
  await ctx.reply(allowed ? `Узел #${id} снова получает рассылки.` : `Узел #${id} исключён из рассылок.`);
});

bot.catch((err) => {
  console.error('Ошибка бота:', err);
  // 🔴 07.09, его прямая просьба: «когда ошибки вылезают — пусть мой бот оповещает».
  // Раньше падение обработчика умирало в логах pm2 на сервере, и о поломке узнавали
  // только когда кто-то жаловался, что бот молчит.
  const where = err.ctx?.from?.username ? `@${err.ctx.from.username}` : String(err.ctx?.from?.id ?? '—');
  void notifyAdmins(bot.api, `❌ Ошибка в станке (у ${where}): ${String(err.error).slice(0, 400)}`);
});

// Аккуратная остановка
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

// Мониторинг узлов: раз в 30 мин проверяем доступность, алертим админам об изменениях.
//
// 🔴 06.09: раньше "уже алертили" держалось в offlineNodes — Set в памяти процесса.
// Несколько деплоев подряд в один день = несколько рестартов станка = Set каждый раз
// пустой заново, и уже виденные мёртвые узлы слались админу как будто только что
// обнаружены. Теперь сравниваем с n.last_health_ok из БД (см. db.ts) — переживает рестарт.
async function monitorNodes(): Promise<void> {
  for (const n of getReadyNodes()) {
    const health = await checkNodeAlive(n.server_ip, decrypt(n.root_password_enc), !!n.is_primary, n.protocol);
    const wasOk = n.last_health_ok !== 0; // NULL (ещё не проверяли) считаем как "было ок" — не алертить на первой проверке
    if (!health.ok && wasOk) {
      await notifyAdmins(
        bot.api,
        `🔴 Узел #${n.id} (${n.server_ip}, @${n.tg_username ?? '—'}) недоступен: ${health.detail}`,
      );
    } else if (health.ok && !wasOk) {
      await notifyAdmins(bot.api, `🟢 Узел #${n.id} (${n.server_ip}) снова онлайн.`);
    }
    setNodeHealthOk(n.id, health.ok);
  }
}
setInterval(() => void monitorNodes(), 30 * 60 * 1000);

// Проверка токенов ботов-продавцов: раз в час.
//
// 🔴 07.09, живой инцидент (Ramazan_LS): владелец перевыпустил токен в @BotFather, бот-продавец
// перестал логиниться в Telegram, упал — и pm2 поднимал его 2333 раза, держа 100% CPU на его же
// сервере. Не заметил никто: владелец видел молчащего бота, монитор смотрел на сервер и VPN,
// но не на сам процесс. Теперь: находим сами, гасим бесполезный цикл перезапусков и просим
// у владельца новый токен его же словами, без диагностики.
//
// 'network' (Telegram недоступен, 429/5xx) НЕ считаем отказом — иначе на первом же сбое
// Telegram мы бы разослали всем владельцам, что у них «отозван токен», и погасили рабочих ботов.
async function monitorSellerTokens(): Promise<void> {
  for (const n of getReadyPrimaryNodes()) {
    const verdict = await verifyBotToken(decrypt(n.seller_token_enc));
    if (verdict.ok || verdict.reason === 'network') continue;

    // Раз в сутки на владельца, а не на каждом проходе — состояние в БД, переживает рестарт.
    if (hadRecentEvent(n.tg_user_id, 'token_invalid', 24)) continue;
    logEvent({ id: n.tg_user_id, username: n.tg_username ?? undefined }, 'token_invalid', `узел #${n.id}, монитор`);

    // Гасим падающий процесс: с мёртвым токеном он всё равно бесполезен, а CPU жрёт.
    let stopped = '';
    try {
      await stopSellerBot(n.server_ip, decrypt(n.root_password_enc));
      stopped = ' Бесполезный перезапуск бота на сервере остановлен.';
    } catch {
      /* сервер недоступен — не страшно, главное сообщить владельцу */
    }

    await bot.api
      .sendMessage(n.tg_user_id, TOKEN_INVALID_HELP + '\n\nКогда будет новый токен — пришли его командой /token.')
      .catch(() => {});
    await notifyAdmins(
      bot.api,
      `🔑 Узел #${n.id} (${n.server_ip}, @${n.tg_username ?? '—'}): токен бота-продавца отозван, бот не работал.` +
        `${stopped} Владельцу написал.`,
    );
  }
}
setInterval(() => void monitorSellerTokens(), 60 * 60 * 1000);
void monitorSellerTokens(); // первый заход сразу при старте

// Сбор выручки узлов: раз в 6 часов молча читаем subs.json — но ТОЛЬКО у узлов,
// которым явно включена доля с продаж (см. db.ts::getRevenueShareNodes). До
// 06.09 это шло по ВСЕМ узлам разом с общим 5% — договорённость такого рода
// реально была только с одним человеком, для остальных это был необоснованный
// SSH-заход на чужой сервер и лишний алерт себе же. Пусто по умолчанию — цикл
// просто ничего не делает, пока кому-то явно не включат.
//
// Почему регулярно, а не по запросу (для тех, кому включено): узел может
// почистить файл, потерять сервер или переустановить бота — увиденная продажа
// остаётся в базе станка навсегда. Раз в 6 часов, а не раз в сутки: так пропажа
// сервера отнимает максимум несколько продаж, а не целый день.
async function collectRevenue(): Promise<void> {
  for (const n of getRevenueShareNodes()) {
    const r = await syncNode(n);
    if (r.ok && r.added > 0) {
      await notifyAdmins(bot.api, `💰 Узел #${n.id} (@${n.tg_username ?? n.server_ip}): +${r.added} продаж. /revenue`);
    }
  }
}
setInterval(() => void collectRevenue(), 6 * 60 * 60 * 1000);
void collectRevenue(); // первый заход сразу при старте

// Бэкап данных владельцев: раз в сутки стягиваем /root/seller-bot-data со всех живых
// primary-узлов к себе (см. backup.ts — зачем и что именно). Не блокирует онбординг:
// если сервер временно недоступен, просто пропускаем этот день, старый бэкап цел.
//
// 🔴 07.09: заведено после живого случая (Ramazan_LS) — хостер пересоздал VPS с новым
// IP, старый сервер умер безвозвратно, а вместе с ним и все настройки бота-продавца.
// До этого дня такого бэкапа не было вообще — восстанавливать было НЕЧЕГО.
async function backupOwnersData(): Promise<void> {
  const r = await backupAllPrimaries();
  if (r.failures.length > 0) {
    await notifyAdmins(bot.api, `⚠️ Суточный бэкап настроек: ${r.ok} ок, ${r.fail} не удалось:\n${r.failures.join('\n')}`);
  }
}
setInterval(() => void backupOwnersData(), 24 * 60 * 60 * 1000);
void backupOwnersData(); // первый заход сразу при старте

// Напоминания застрявшим и узлам перед концом оплаченной недели (см. nudges.ts — правила).
setInterval(() => void runNudges(bot.api).catch((e) => console.error('Напоминания:', e)), 15 * 60 * 1000);
setTimeout(() => void runNudges(bot.api).catch((e) => console.error('Напоминания:', e)), 60 * 1000);

// Журнал диалога — разбор, а не архив.
setInterval(() => pruneChatLog(), 24 * 60 * 60 * 1000);
pruneChatLog();

await bot.start({
  onStart: (info) => console.log(`Станок-бот @${info.username} запущен`),
});
