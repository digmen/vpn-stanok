/**
 * Прогон мастера настройки на настоящем grammY без Telegram: апдейты подаём руками,
 * ответы Bot API подделываем. Проверяет то, что юнит-тесты не видят, — поведение внутри
 * плагина conversations (перепроигрывание, выход по команде, отметка «секрет» на пароле).
 *
 *   HARNESS_HOST=<ip сервера, где ssh на 22 открыт> npx tsx scripts/harness-onboarding.ts
 *
 * ⚠️ Делает ОДНУ попытку входа по ssh с заведомо неверным паролем на HARNESS_HOST.
 * Бери свой сервер. База — временная, живой stanok.db не трогается.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.BOT_TOKEN = '1:harness';
process.env.ENCRYPTION_KEY ??= 'b'.repeat(64);
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-harness-')), 'h.db');
process.env.ADMIN_IDS = '999';

const HOST = process.env.HARNESS_HOST;
if (!HOST) throw new Error('нужен HARNESS_HOST');

const { Bot, session } = await import('grammy');
const { conversations, createConversation } = await import('@grammyjs/conversations');
const { onboarding } = await import('../src/onboarding.js');
const C = await import('../src/chat-log.js');
const { db } = await import('../src/db.js');

const { acceptTerms } = await import('../src/terms.js');

const U = 4242;
// С 22.10 перед мастером показываются условия; этот прогон не про них — принимаем заранее.
acceptTerms(U);
let msgId = 100;
const sent: { method: string; text?: string }[] = [];

const bot = new Bot<any>('1:harness', {
  botInfo: { id: 1, is_bot: true, first_name: 'h', username: 'h_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any,
});
// Подделка Telegram — самый внутренний слой; журнал — поверх, как в index.ts.
bot.api.config.use(async (_prev, method, payload: any) => {
  sent.push({ method, text: payload?.text ?? payload?.caption });
  return { ok: true, result: method.startsWith('send') ? { message_id: ++msgId, chat: { id: U }, date: 0 } : true } as any;
});
bot.api.config.use(C.logOutgoing);
bot.use(C.logIncoming);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(async (ctx: any, next) => {
  if (ctx.message?.text?.startsWith('/')) {
    const active = await ctx.conversation.active();
    if (Object.keys(active).length > 0) await ctx.conversation.exit();
    if (ctx.from) C.clearSecretWait(ctx.from.id);
  }
  await next();
});
bot.use(createConversation(onboarding));
bot.command('start', (ctx) => ctx.reply('START_SCREEN'));
bot.callbackQuery('setup', async (ctx: any) => {
  await ctx.answerCallbackQuery();
  if (Object.keys(await ctx.conversation.active()).length > 0) await ctx.conversation.exit();
  await ctx.conversation.enter('onboarding');
});

let upd = 1;
const from = { id: U, is_bot: false, first_name: 'T', username: 'harness' };
const chat = { id: U, type: 'private' as const, first_name: 'T' };
const text = (t: string) =>
  bot.handleUpdate({ update_id: upd++, message: { message_id: ++msgId, date: 0, chat, from, text: t, ...(t.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] } : {}) } } as any);
const press = (data: string) =>
  bot.handleUpdate({ update_id: upd++, callback_query: { id: String(upd), from, chat_instance: 'x', data, message: { message_id: 1, date: 0, chat, text: 'x' } } } as any);

const fails: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) fails.push(name);
};
const lastBot = () => [...sent].reverse().find((s) => s.text)?.text ?? '';

await press('setup');
check('мастер спросил IP', lastBot().startsWith('1️⃣ Пришли IP'));

await text('/start');
check('/start посреди мастера выводит из него и показывает старт', lastBot() === 'START_SCREEN');

await press('setup');
await text('а где его взять?');
check('на вопрос — подсказка про покупку', sent.some((s) => s.text?.includes('после покупки сервера')));

await text(`root@${HOST}:22`);
check('IP вытащен из «root@…:22», сервер ответил', sent.some((s) => s.text?.includes(`Сервер ${HOST} отвечает`)));
check('после IP спрашивает протокол (три кнопки)', sent.some((s) => s.text?.startsWith('🔧 Какой протокол')));
await press('proto:wireguard');
check('чужой протокол не принимается, мастер ждёт', !lastBot().startsWith('2️⃣ Пришли root-пароль'));
await press('proto:vless_reality');
check('дальше спрашивает пароль', lastBot().startsWith('2️⃣ Пришли root-пароль'));

await text('definitely-wrong-password-42');
check('неверный пароль пойман на своём шаге', lastBot().startsWith('❌ Сервер не принял этот пароль'));

const log = C.chatTranscript(U, 500);
const dump = JSON.stringify(log);
check('пароль не попал в журнал диалога', !dump.includes('definitely-wrong'));
check('вместо пароля — «[пароль скрыт]»', log.some((r) => r.dir === 'in' && r.text === '[пароль скрыт]'));
check('вопрос человека в журнале', log.some((r) => r.dir === 'in' && r.text === 'а где его взять?'));
check('ответы бота в журнале', log.some((r) => r.dir === 'out' && r.text?.startsWith('1️⃣ Пришли IP')));
const outs = log.filter((r) => r.dir === 'out').map((r) => r.text);
check('перепроигрывание мастера не задвоило ответы бота', new Set(outs).size === outs.length || outs.length < sent.length);
const steps = (db.prepare('SELECT step FROM events WHERE tg_user_id = ? ORDER BY id').all(U) as { step: string }[]).map((r) => r.step);
check('шаги: ip_rejected → ip_ok → preflight_ok → protocol_chosen → password_wrong', ['ip_rejected', 'ip_ok', 'preflight_ok', 'protocol_chosen', 'password_wrong'].every((s) => steps.includes(s)));
check('выбранный протокол записан в журнал', (db.prepare("SELECT detail FROM events WHERE step='protocol_chosen'").get() as { detail: string } | undefined)?.detail === 'vless_reality');
check('шаги не задвоились', steps.filter((s) => s === 'protocol_chosen').length === 1 && steps.filter((s) => s === 'password_wrong').length === 1 && steps.filter((s) => s === 'preflight_ok').length === 1);

await text('/start');
check('после /start отметка «секрет» снята', (db.prepare('SELECT COUNT(*) c FROM secret_wait').get() as { c: number }).c === 0);

// ── Сценарий 2 (обращение #14, 07.11): основной сервер больше не принимает сохранённый пароль ──
// Второй сервер берём чужой, но с открытым 22 (проверка — только TCP-соединение, без входа).
const OTHER = process.env.HARNESS_OTHER_HOST;
if (OTHER) {
  const { upsertNode, setNodeStatus } = await import('../src/db.js');
  const { encrypt } = await import('../src/crypto.js');
  const nid = upsertNode({
    tgUserId: U, tgUsername: 'harness', serverIp: HOST, rootPasswordEnc: encrypt('stale-old-password-1'),
    sellerTokenEnc: encrypt('1:fake'), isPrimary: true, protocol: 'vless_ws_tls',
  });
  setNodeStatus(nid, 'ready');
  sent.length = 0;
  await press('setup');
  await text(OTHER);
  await press('proto:amneziawg');
  check('основной не пускает → мастер говорит об ОСНОВНОМ сервере', sent.some((s) => s.text?.includes('основной сервер') && s.text?.includes('больше не принимает')));
  check('и НЕ просит пароль нового, пока не решено с основным', !sent.some((s) => s.text?.startsWith('2️⃣ Пришли root-пароль')));
  await press('pw_gone');
  check('«основного больше нет» → дальше пароль нового', lastBot().startsWith('2️⃣ Пришли root-пароль'));
  const steps2 = (db.prepare('SELECT step FROM events WHERE tg_user_id = ? ORDER BY id').all(U) as { step: string }[]).map((r) => r.step);
  check('в журнале: primary_password_bad и primary_gone', steps2.includes('primary_password_bad') && steps2.includes('primary_gone'));
}

console.log('\nЖурнал диалога:');
for (const r of C.chatTranscript(U, 500)) console.log(`  ${r.dir === 'in' ? '👤' : '🤖'} ${(r.text ?? '').split('\n')[0].slice(0, 90)}`);
console.log('\nШаги:', steps.join(' → '));
console.log(fails.length ? `\n❌ Не прошло: ${fails.length}` : '\n✅ Всё прошло');
process.exit(fails.length ? 1 : 0);
