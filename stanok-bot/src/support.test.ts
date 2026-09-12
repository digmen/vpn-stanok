import { beforeAll, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Полный круг поддержки на настоящем grammY без Telegram: клиент пишет → карточка админу →
// ответ админа ответом на сообщение → клиенту. База временная.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-test-')), 'test.db');
process.env.ADMIN_IDS = '999';

const ADMIN = 999;
const USER = 5555;
type Call = { method: string; payload: Record<string, any> };
const calls: Call[] = [];
let msgId = 1000;

let bot: import('grammy').Bot;
let S: typeof import('./support/store.js');
let X: typeof import('./support/context.js');
let CH: typeof import('./channel.js');

beforeAll(async () => {
  const { Api, Bot } = await import('grammy');
  S = await import('./support/store.js');
  X = await import('./support/context.js');
  CH = await import('./channel.js');
  const { createSupportBot } = await import('./support/bot.js');
  const fake = async (_prev: unknown, method: string, payload: any) => {
    calls.push({ method, payload });
    if (method === 'getChatMember') return { ok: false, error_code: 400, description: 'member list is inaccessible' };
    return { ok: true, result: method.startsWith('send') || method === 'copyMessage' ? { message_id: ++msgId, date: 0, chat: { id: payload.chat_id } } : true };
  };
  const stanokApi = new Api('1:stanok');
  stanokApi.config.use(fake as never);
  bot = createSupportBot('2:support', stanokApi);
  (bot as any).botInfo = { id: 2, is_bot: true, first_name: 's', username: 's_bot' };
  bot.api.config.use(fake as never);
});

let upd = 1;
const chatOf = (id: number) => ({ id, type: 'private' as const, first_name: 'x' });
const fromOf = (id: number, username?: string) => ({ id, is_bot: false, first_name: 'x', username });
async function msg(from: number, text: string, replyTo?: number) {
  const m: any = { message_id: ++msgId, date: 0, chat: chatOf(from), from: fromOf(from, from === USER ? 'client' : 'boss'), text };
  if (text.startsWith('/')) m.entities = [{ type: 'bot_command', offset: 0, length: text.length }];
  if (replyTo) m.reply_to_message = { message_id: replyTo, date: 0, chat: chatOf(from) };
  await bot.handleUpdate({ update_id: upd++, message: m } as never);
  return m.message_id as number;
}
async function press(from: number, data: string) {
  await bot.handleUpdate({
    update_id: upd++,
    callback_query: { id: String(upd), from: fromOf(from), chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: chatOf(from), text: 'x' } },
  } as never);
}
const sentTo = (chat: number) => calls.filter((c) => c.payload.chat_id === chat && (c.method === 'sendMessage' || c.method === 'copyMessage'));

describe('бот поддержки: полный круг', () => {
  it('клиент пишет → обращение, карточка и сообщение админу, клиенту «Принято»', async () => {
    await msg(USER, '/start');
    expect(sentTo(USER).at(-1)!.payload.text).toContain('поддержка');
    await msg(USER, 'бот не отвечает');
    const t = S.openTicketOf(USER)!;
    expect(t.id).toBe(1);
    const toAdmin = sentTo(ADMIN).map((c) => c.payload.text);
    expect(toAdmin[0]).toContain('Обращение #1');
    expect(toAdmin[0]).toContain('В станке не был');
    expect(toAdmin[1]).toBe('💬 #1 @client:\nбот не отвечает');
    expect(sentTo(USER).at(-1)!.payload.text).toContain('Обращение #1');
  });

  it('ответ админа ответом на карточку уходит клиенту и засчитывается как первый ответ', async () => {
    const route = findRouteFor(1);
    expect(route).not.toBeNull();
    await msg(ADMIN, 'перезапусти сервер', route!);
    expect(sentTo(USER).at(-1)!.payload.text).toBe('🧑‍💻 Поддержка:\nперезапусти сервер');
    expect(S.getTicket(1)!.first_reply_at).not.toBeNull();
  });

  it('ответ не на сообщение обращения — админу подсказка, клиенту ничего', async () => {
    const before = sentTo(USER).length;
    await msg(ADMIN, 'куда это?', 1);
    expect(sentTo(ADMIN).at(-1)!.payload.text).toContain('Не понял');
    expect(sentTo(USER).length).toBe(before);
  });

  it('второе сообщение идёт в то же обращение', async () => {
    await msg(USER, 'всё равно не работает');
    expect(S.openTicketOf(USER)!.id).toBe(1);
    expect(S.ticketMessages(1).filter((m) => m.dir === 'in')).toHaveLength(2);
  });

  it('закрыть → клиенту сообщение; новое сообщение — новое обращение с пометкой о прошлом', async () => {
    await press(ADMIN, 'close:1');
    expect(S.getTicket(1)!.status).toBe('closed');
    expect(sentTo(USER).at(-1)!.payload.text).toContain('#1 закрыто');
    await msg(USER, 'опять сломалось');
    expect(S.openTicketOf(USER)!.id).toBe(2);
    const card = sentTo(ADMIN).map((c) => String(c.payload.text)).find((t) => t.startsWith('🆘 Обращение #2'))!;
    expect(card).toContain('Обращался раньше: 1 (#1)');
    expect(card).toContain('Канал: не проверить');
  });

  it('статистика и список открытых', () => {
    const st = X.supportStats();
    expect(st).toContain('всего обращений 2');
    expect(st).toContain('Открыто: 1 · закрыто: 1');
    expect(X.openList(S.openTickets())).toContain('#2 @client');
  });
});

describe('подписка на канал', () => {
  it('кто считается подписанным', () => {
    expect(CH.isMemberStatus('member')).toBe(true);
    expect(CH.isMemberStatus('administrator')).toBe(true);
    expect(CH.isMemberStatus('left')).toBe(false);
    expect(CH.isMemberStatus('kicked')).toBe(false);
    expect(CH.isMemberStatus('restricted', true)).toBe(true);
    expect(CH.isMemberStatus('restricted', false)).toBe(false);
  });
});

/** Первое сообщение у админа, привязанное к обращению (карточка), — на него и отвечаем. */
function findRouteFor(ticketId: number): number | null {
  for (let id = 1000; id <= msgId; id++) if (S.routeOf(ADMIN, id) === ticketId) return id;
  return null;
}
