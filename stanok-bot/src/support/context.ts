import { db, getNodesByUser } from '../db.js';
import { loadUserStates, stuckAt, toMs, type UserState } from '../analytics.js';
import { chatTranscript } from '../chat-log.js';
import { allTickets, ticketsOf, type Ticket } from './store.js';

// Что знает о человеке станок — к карточке обращения. Чтобы отвечать сразу по делу,
// а не начинать с «пришли скрин» и «на каком ты шаге».

/**
 * Что станок знает о человеке. Только если он прошёл хоть одну ступень настройки:
 * само обращение в поддержку тоже пишется в журнал (support_msg), и без этой проверки
 * любой написавший выглядел бы «застрявшим в станке» (поймано тестом 13.09).
 */
export function userState(userId: number): UserState | undefined {
  const u = loadUserStates().find((x) => x.id === userId);
  return u && u.best !== null ? u : undefined;
}

/** Где человек сейчас — одной строкой; null — в станке не был. */
export function stageOf(userId: number): string | null {
  const u = userState(userId);
  if (!u) return null;
  return u.failsBeforeOk !== null ? 'узел поднят' : stuckAt(u);
}

function ago(sql: string, now = Date.now()): string {
  const m = Math.round((now - toMs(sql)) / 60_000);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн. назад`;
}

/** Шапка карточки обращения для админа. */
export function ticketCard(t: Ticket, subscribed: 'yes' | 'no' | 'unknown'): string {
  const who = t.tg_username ? '@' + t.tg_username : `id ${t.tg_user_id}`;
  const u = userState(t.tg_user_id);
  const lines = [`🆘 Обращение #${t.id} — ${who} (id ${t.tg_user_id})`];

  if (!u) {
    lines.push('В станке не был.');
  } else {
    const stage = u.failsBeforeOk !== null ? `✅ узел поднят (ошибок до этого: ${u.failsBeforeOk})` : `застрял: ${stuckAt(u)}`;
    lines.push(`В станке: ${stage}`);
    lines.push(`Пришёл ${ago(new Date(u.firstAt).toISOString().slice(0, 19).replace('T', ' '))}, последнее действие ${ago(new Date(u.lastAt).toISOString().slice(0, 19).replace('T', ' '))}`);
    if (u.lastFail) lines.push(`Последняя ошибка: ${u.lastFail.step}${u.lastFail.detail ? ' · ' + u.lastFail.detail.slice(0, 80) : ''}`);
  }

  const nodes = getNodesByUser(t.tg_user_id);
  for (const n of nodes.slice(-3)) {
    const health = n.status === 'ready' ? (n.last_health_ok === 0 ? '🔴 не отвечает' : '🟢') : n.status;
    lines.push(`Узел #${n.id} ${n.server_ip} · ${health}`);
  }

  lines.push(`Канал: ${subscribed === 'yes' ? 'подписан' : subscribed === 'no' ? 'не подписан' : 'не проверить'}`);
  const prev = ticketsOf(t.tg_user_id).filter((x) => x.id !== t.id);
  if (prev.length) lines.push(`Обращался раньше: ${prev.length} (${prev.map((x) => '#' + x.id).join(', ')})`);
  lines.push('', '↩️ Ответь на это сообщение — ответ уйдёт ему.');
  return lines.join('\n');
}

/** Последнее из диалога со станком — что он видел перед тем, как написать. */
export function stanokTail(userId: number, n = 12): string {
  const rows = chatTranscript(userId, n);
  if (rows.length === 0) {
    const ev = db
      .prepare('SELECT step, detail, created_at FROM events WHERE tg_user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, n) as { step: string; detail: string | null; created_at: string }[];
    if (ev.length === 0) return 'В станке ничего нет.';
    return 'Шаги в станке:\n' + ev.reverse().map((e) => `${e.created_at.slice(5, 16)} ${e.step} ${e.detail ?? ''}`).join('\n');
  }
  return (
    'Последнее в станке (👤 он · 🤖 бот):\n' +
    rows.map((r) => `${r.created_at.slice(5, 16)} ${r.dir === 'in' ? '👤' : '🤖'} ${(r.text ?? '').slice(0, 200)}`).join('\n')
  );
}

/**
 * Подсказка человеку сразу, пока ждёт ответа, — если станок уже видит частую причину.
 * Только то, что следует из журнала; догадок не пишем.
 */
export function autoHint(userId: number): string | null {
  const nodes = getNodesByUser(userId);
  const down = nodes.find((n) => n.status === 'ready' && n.last_health_ok === 0);
  if (down) {
    return (
      `Вижу, что твой сервер ${down.server_ip} сейчас не отвечает. Частая причина — закончился оплаченный срок ` +
      'у хостинга. Проверь в панели хостинга, что сервер оплачен и включён.'
    );
  }
  const u = userState(userId);
  if (!u || u.failsBeforeOk !== null) return null;
  switch (stuckAt(u)) {
    case 'не прислал IP':
    case 'не смог прислать IP':
      return (
        'Вижу, что настройка остановилась на IP. Он в панели хостинга → твой сервер → строка «IP-адрес» ' +
        '(четыре числа через точку), и в письме после покупки. Сервера ещё нет — сначала купи его: /start в @VPNForge_bot.'
      );
    case 'сервер не отвечал':
      return (
        'Вижу, что твой сервер не отвечал на подключение. Почти всегда это не купленный «Выделенный IP» — ' +
        'его можно добавить к серверу в панели хостинга (~50–65 ₽), потом пришли в @VPNForge_bot новый адрес.'
      );
    case 'установка упала':
      return 'Вижу, что установка на твоём сервере упала — подробности ошибки у меня уже есть, разберусь.';
    default:
      return null;
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} мин` : `${(m / 60).toFixed(1)} ч`);

/** Статистика поддержки: сколько, как быстро отвечаем, помогла ли. */
export function supportStats(now = Date.now()): string {
  const all = allTickets();
  if (all.length === 0) return 'Обращений пока не было.';
  const open = all.filter((t) => t.status === 'open');
  const answered = all.filter((t) => t.first_reply_at);
  const waits = answered.map((t) => (toMs(t.first_reply_at!) - toMs(t.created_at)) / 60_000);
  const unanswered = open.filter((t) => !t.first_reply_at);

  // Помогла ли: у скольких узел поднялся ПОСЛЕ обращения.
  const okAfter = all.filter((t) => {
    const r = db
      .prepare(`SELECT 1 FROM events WHERE tg_user_id = ? AND step = 'provision_ok' AND created_at > ? LIMIT 1`)
      .get(t.tg_user_id, t.created_at);
    return r !== undefined;
  });
  const hadNoNode = all.filter((t) => t.stage !== 'узел поднят');

  const byStage = new Map<string, number>();
  for (const t of all) byStage.set(t.stage ?? 'в станке не был', (byStage.get(t.stage ?? 'в станке не был') ?? 0) + 1);

  const lines = [
    `📊 Поддержка — всего обращений ${all.length}`,
    `Открыто: ${open.length} · закрыто: ${all.length - open.length}`,
    `Первый ответ: медиана ${fmtMin(median(waits))}` + (waits.length ? `, самый долгий ${fmtMin(Math.max(...waits))}` : ''),
  ];
  if (unanswered.length) {
    lines.push(
      `⏳ Ждут ответа: ${unanswered.map((t) => `#${t.id} (${fmtMin((now - toMs(t.created_at)) / 60_000)})`).join(', ')}`,
    );
  }
  lines.push(`После обращения подняли узел: ${okAfter.length} из ${hadNoNode.length} (у кого его не было)`);
  lines.push('', 'Где были, когда написали:');
  for (const [stage, n] of [...byStage].sort((a, b) => b[1] - a[1])) lines.push(`• ${stage}: ${n}`);
  return lines.join('\n');
}

export function openList(tickets: (Ticket & { last_in: string | null; last_out: string | null })[]): string {
  if (tickets.length === 0) return '📥 Открытых обращений нет.';
  return (
    `📥 Открытые (${tickets.length}):\n` +
    tickets
      .map((t) => {
        const who = t.tg_username ? '@' + t.tg_username : String(t.tg_user_id);
        const waiting = t.last_in && (!t.last_out || t.last_in > t.last_out) ? ' · ⏳ ждёт ответа' : '';
        return `#${t.id} ${who} — ${t.stage ?? 'в станке не был'}, написал ${t.last_in ? ago(t.last_in) : '—'}${waiting}`;
      })
      .join('\n')
  );
}
