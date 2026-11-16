import { describe, expect, it, jest } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// personal.ts хранит выбор в kv, а kv тянет базу и конфиг — временная база, как в terms.test.ts.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-personal-')), 'test.db');

// Мастер настройки ходит на сервер по SSH (порт 22, пароль) и проверяет Telegram с сервера.
// В тесте сервера нет — подменяем эти проверки на «всё ок», остальное настоящее.
jest.unstable_mockModule('./preflight.js', () => ({
  checkSshPort: async () => ({ ok: true }),
  checkSshLogin: async () => 'ok',
  isAuthFailure: () => false,
  preflightMessage: () => 'preflight',
}));
jest.unstable_mockModule('./tg-reach.js', () => ({
  TG_REACH_COMMAND: '',
  parseTgReach: () => 'ok',
  checkTelegramFromServer: async () => 'ok',
  telegramBlockedMessage: () => 'blocked',
  TelegramUnreachableError: class extends Error {},
  getMeConfig: () => '',
  parseGetMe: () => ({ ok: true }),
  botReachesTelegram: async () => ({ ok: true }),
}));

const P = await import('./personal.js');
const { buyGuideText } = await import('./host-guide.js');
const { Bot, session } = await import('grammy');
const { conversations, createConversation } = await import('@grammyjs/conversations');
const { onboarding } = await import('./onboarding.js');
const { db, getNodeById } = await import('./db.js');
const { acceptTerms } = await import('./terms.js');

type Btn = { text: string; callback_data?: string; url?: string };
const buttons = (kb: { inline_keyboard: unknown[][] }) => kb.inline_keyboard.flat() as Btn[];

describe('первый экран: сначала «для себя», потом бизнес', () => {
  it('главная кнопка — свой VPN, вторая — VPN-бизнес', () => {
    const b = buttons(P.startKeyboard());
    expect(b.map((x) => x.text)).toEqual(['🔒 Свой VPN для себя', '💰 VPN-бизнес: продавай доступ']);
    expect(b.map((x) => P.parseModeCallback(x.callback_data!))).toEqual(['personal', 'business']);
  });

  it('поддержка — третьей строкой, только если задана', () => {
    expect(buttons(P.startKeyboard('https://t.me/x')).at(-1)?.url).toBe('https://t.me/x');
    expect(buttons(P.startKeyboard())).toHaveLength(2);
  });

  it('текст: свой сервер, 5 минут, без ПК, бизнес упомянут вторым', () => {
    expect(P.START_TEXT).toContain('5 минут');
    expect(P.START_TEXT).toContain('компьютер');
    expect(P.START_TEXT.indexOf('свой VPN')).toBeLessThan(P.START_TEXT.indexOf('VPN-бизнес'));
    expect(P.START_TEXT.length).toBeLessThan(1024);
  });

  it('разбор callback режима: чужое не угадывается', () => {
    expect(P.parseModeCallback('mode:personal')).toBe('personal');
    expect(P.parseModeCallback('mode:business')).toBe('business');
    expect(P.parseModeCallback('mode:free')).toBeNull();
    expect(P.parseModeCallback('proto:amneziawg')).toBeNull();
  });
});

describe('экран «для себя» и покупка сервера', () => {
  it('советует месяц и выделенный IP, токен бота не упоминает', () => {
    expect(P.PERSONAL_TEXT).toMatch(/на месяц/);
    expect(P.PERSONAL_TEXT).toMatch(/Выделенный IP/);
    expect(P.PERSONAL_TEXT).not.toMatch(/токен|BotFather/i);
    expect(P.step2Text('personal')).not.toMatch(/токен|BotFather/i);
    expect(P.step2Text('business')).toMatch(/BotFather/);
  });

  it('бизнес-экран — прежний текст первого экрана (про ботов и Stars)', () => {
    expect(P.BUSINESS_TEXT).toContain('Telegram Stars');
    expect(P.BUSINESS_TEXT).toContain('токен бота');
  });

  it('с экрана режима можно купить, сказать «купил» и переключиться на другой режим', () => {
    const p = buttons(P.modeKeyboard('personal')).map((x) => x.callback_data);
    expect(p).toEqual(['buy', 'bought', 'mode:business']);
    expect(buttons(P.modeKeyboard('business')).at(-1)?.callback_data).toBe('mode:personal');
  });

  it('инструкция покупки «для себя»: месяц вместо бесплатной недели, без бота', () => {
    const t = buyGuideText('personal');
    expect(t).toMatch(/на месяц/);
    expect(t).not.toMatch(/бесплатно/);
    expect(t).not.toMatch(/твой бот/);
    expect(buyGuideText()).toMatch(/твой бот/); // бизнес — как было
  });
});

describe('выбор режима хранится в базе', () => {
  it('не выбирал — бизнес (как до 17.11); выбрал — помнится', () => {
    expect(P.getUserMode(101)).toBe('business');
    P.setUserMode(101, 'personal');
    expect(P.getUserMode(101)).toBe('personal');
    P.setUserMode(101, 'business');
    expect(P.getUserMode(101)).toBe('business');
  });
});

describe('готовый личный VPN', () => {
  it('приложение по протоколу и кнопка «зарабатывать на этом сервере»', () => {
    const b = buttons(P.personalReadyKeyboard('amneziawg', 7));
    expect(b[0].text).toContain('AmneziaVPN');
    expect(b[1].text).toContain('AmneziaVPN');
    expect(b[2].callback_data).toBe('upgrade:7');
    expect(buttons(P.personalReadyKeyboard('vless_ws_tls', 7))[0].text).toContain('OneXray');
  });

  it('текст: как импортировать, ключ не публиковать, продлевать сервер', () => {
    const t = P.personalReadyText('1.2.3.4', 'vless_reality');
    expect(t).toContain('1.2.3.4');
    expect(t).toContain('импорт по ссылке');
    expect(t).toMatch(/не публикуй/);
    expect(t).toMatch(/оплачен/);
    expect(P.personalReadyText('1.2.3.4', 'amneziawg')).toContain('импорт из файла');
    expect(P.personalReadyText('1.2.3.4', 'amneziawg')).not.toContain('второй телефон');
  });

  it('файл ключа без точек в имени', () => {
    expect(P.keyFileName('1.2.3.4')).toBe('amnezia-1-2-3-4.conf');
  });
});

// ── Мастер настройки на настоящем grammY без Telegram (как scripts/harness-onboarding.ts) ──
function harness(userId: number) {
  let msgId = 100;
  const sent: { method: string; text?: string; kb?: Btn[] }[] = [];
  const bot = new Bot<any>('1:test', {
    botInfo: { id: 1, is_bot: true, first_name: 'h', username: 'h_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any,
  });
  bot.api.config.use(async (_prev, method, payload: any) => {
    sent.push({ method, text: payload?.text ?? payload?.caption, kb: payload?.reply_markup?.inline_keyboard?.flat() });
    return { ok: true, result: method.startsWith('send') ? { message_id: ++msgId, chat: { id: userId }, date: 0 } : true } as any;
  });
  bot.use(session({ initial: () => ({}) }));
  bot.use(conversations());
  bot.use(createConversation(onboarding));
  bot.callbackQuery('setup', async (ctx: any) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter('onboarding');
  });
  let upd = 1;
  const from = { id: userId, is_bot: false, first_name: 'T', username: 'u' + userId };
  const chat = { id: userId, type: 'private' as const, first_name: 'T' };
  const text = (t: string) =>
    bot.handleUpdate({ update_id: upd++, message: { message_id: ++msgId, date: 0, chat, from, text: t } } as any);
  const press = (data: string) =>
    bot.handleUpdate({ update_id: upd++, callback_query: { id: String(upd), from, chat_instance: 'x', data, message: { message_id: 1, date: 0, chat, text: 'x' } } } as any);
  return { sent, text, press };
}

const steps = (userId: number) =>
  (db.prepare('SELECT step, detail FROM events WHERE tg_user_id = ? ORDER BY id').all(userId) as { step: string; detail: string | null }[]);

describe('мастер настройки', () => {
  it('«для себя»: IP → протокол → пароль → «Поднять VPN», токен бота НЕ спрашивается', async () => {
    const U = 5001;
    P.setUserMode(U, 'personal');
    const h = harness(U);
    await h.press('setup');
    expect(h.sent.some((s) => s.text?.startsWith('📄 Перед настройкой'))).toBe(false); // условия для ботов не показываем
    await h.text('45.67.89.10');
    await h.press('proto:vless_reality');
    await h.text('correct-horse-battery');

    expect(h.sent.some((s) => /токен|BotFather/i.test(s.text ?? ''))).toBe(false);
    const last = h.sent.filter((s) => s.text).at(-1)!;
    expect(last.text).toContain('пришлю твой ключ');
    const btn = last.kb?.find((b) => b.callback_data?.startsWith('provision:'));
    expect(btn).toBeDefined();

    const node = getNodeById(Number(btn!.callback_data!.split(':')[1]))!;
    expect(node.mode).toBe('personal');
    expect(node.is_primary).toBe(0);
    expect(node.protocol).toBe('vless_reality');
    expect(steps(U).map((s) => s.step)).not.toContain('token_ok');
  });

  it('бизнес (как раньше): после пароля спрашивает токен бота-продавца', async () => {
    const U = 5002;
    P.setUserMode(U, 'business');
    acceptTerms(U);
    const h = harness(U);
    await h.press('setup');
    await h.text('45.67.89.11');
    await h.press('proto:vless_ws_tls');
    await h.text('correct-horse-battery');
    expect(h.sent.filter((s) => s.text).at(-1)?.text).toMatch(/^3️⃣ Пришли токен твоего бота-продавца/);
  });

  it('режим не выбирали (старые кнопки) — бизнес-путь с токеном', async () => {
    const U = 5003;
    acceptTerms(U);
    const h = harness(U);
    await h.press('setup');
    await h.text('45.67.89.12');
    await h.press('proto:amneziawg');
    await h.text('correct-horse-battery');
    expect(h.sent.filter((s) => s.text).at(-1)?.text).toMatch(/токен/);
  });
});
