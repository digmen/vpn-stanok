/**
 * Разовая рассылка 13.09 от станка: «хочешь протестировать VPN — бери сервер на 7 дней
 * бесплатно» с кнопкой на реферальную ссылку. Его просьба: одна рассылка, один раз, без команд.
 *
 * Кому: заходили в станок, но до сервера, который ответил, не дошли (analytics.inviteTargets);
 * кто нажал «Не напоминать» — нет, админам — нет. Повторно тем же людям не шлёт (метка в журнале).
 * Откат — /undo в станке: рассылка пишется в тот же broadcasts.json, что и /say.
 *
 *   npx tsx scripts/send-invite.ts         — показать текст и получателей, ничего не слать
 *   npx tsx scripts/send-invite.ts --yes   — отправить
 * Запускать на сервере из папки stanok-bot (там база и .env).
 */
import 'dotenv/config';
import { Api, InlineKeyboard } from 'grammy';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { inviteTargets } from '../src/analytics.js';
import { logEvent } from '../src/events.js';
import { logOutgoing } from '../src/chat-log.js';
import { broadcast } from '../src/broadcast.js';

// Про выделенный IP — честно: он платный и в бесплатную неделю, иначе человек почувствует,
// что его заманили «бесплатно», а на кассе попросили денег.
const TEXT =
  'Привет! 👋 Хочешь сначала просто протестировать VPN?\n\n' +
  'Бери сервер на 7 дней бесплатно — промокод хостинг даёт каждому новому клиенту. ' +
  'Купил — возвращайся сюда: за пару минут я подниму на нём твой личный VPN, и ты сразу ' +
  'сможешь им пользоваться. Понравится — продавай доступ другим через своего бота за ⭐️.\n\n' +
  '⚠️ При заказе отметь «Выделенный IP» (~50–65 ₽, он платный и в бесплатную неделю) — ' +
  'без него VPN не заработает.';

const kb = new InlineKeyboard()
  .url('🎁 Взять сервер на 7 дней бесплатно', config.referralLink)
  .row()
  .text('✅ Я купил сервер', 'bought');

const already = new Set(
  (db.prepare(`SELECT DISTINCT tg_user_id id FROM events WHERE step = 'nudge' AND detail LIKE 'invite%'`).all() as { id: number }[]).map(
    (r) => r.id,
  ),
);
const targets = inviteTargets(config.adminIds).filter((u) => !already.has(u.id));

console.log(TEXT + '\n\n[кнопки: 🎁 Взять сервер на 7 дней бесплатно → ' + config.referralLink + ' | ✅ Я купил сервер]\n');
console.log(`Получат ${targets.length}: ` + targets.map((u) => (u.username ? '@' + u.username : u.id)).join(', '));

if (!process.argv.includes('--yes')) {
  console.log('\nЭто просмотр. Отправить: --yes');
  process.exit(0);
}

const api = new Api(config.botToken);
api.config.use(logOutgoing);
const { record, failed } = await broadcast(api, targets.map((u) => u.id), TEXT, kb);
for (const u of targets) logEvent({ id: u.id, username: u.username ?? undefined }, 'nudge', failed.includes(u.id) ? 'invite не доставлено' : 'invite');
console.log(`\nОтправлено: ${record.sent.length} из ${targets.length}, не доставлено: ${failed.length}`);
