import { db } from './db.js';
import { FUNNEL_STEPS, type FunnelStep } from './events.js';
import { rejectedIpInputs } from './chat-log.js';

// Сводка по людям: докуда дошёл, сколько раз ошибся, ушёл ли. Считается из журнала шагов
// (events) и журнала диалога (chat_log) — одна правда для /funnel в боте, отчёта
// в консоли и напоминаний застрявшим (nudges.ts).

/** Шаги-ошибки: всё, что вернуло человека назад. «С первого раза» = ни одной до узла. */
export const FAIL_STEPS = new Set([
  'ip_rejected',
  'ip_taken',
  'preflight_fail',
  'provision_fail',
  'password_wrong',
  'token_invalid',
  'token_taken',
]);

/** Сколько без движения, чтобы считать человека ушедшим. */
export const GONE_AFTER_MS = 3 * 24 * 3600_000;

export interface UserState {
  id: number;
  username: string | null;
  firstAt: number;
  /** Последнее действие САМОГО человека (напоминания бота не в счёт). */
  lastAt: number;
  best: FunnelStep | null;
  /** Ошибок до первого поднятого узла; null — узла нет. */
  failsBeforeOk: number | null;
  lastFail: { step: string; detail: string | null } | null;
  nudges: { kind: string; at: number }[];
  off: boolean;
}

export const toMs = (sqlTime: string): number => Date.parse(sqlTime.replace(' ', 'T') + 'Z');

export function loadUserStates(): UserState[] {
  const rows = db
    .prepare('SELECT tg_user_id, tg_username, step, detail, created_at FROM events ORDER BY id')
    .all() as { tg_user_id: number; tg_username: string | null; step: string; detail: string | null; created_at: string }[];
  const lastIn = new Map<number, number>();
  for (const r of db
    .prepare(`SELECT tg_user_id, MAX(created_at) at FROM chat_log WHERE dir = 'in' GROUP BY tg_user_id`)
    .all() as { tg_user_id: number; at: string }[]) {
    lastIn.set(r.tg_user_id, toMs(r.at));
  }

  const by = new Map<number, UserState>();
  const fails = new Map<number, number>();
  for (const r of rows) {
    const at = toMs(r.created_at);
    let u = by.get(r.tg_user_id);
    if (!u) {
      u = { id: r.tg_user_id, username: null, firstAt: at, lastAt: at, best: null, failsBeforeOk: null, lastFail: null, nudges: [], off: false };
      by.set(r.tg_user_id, u);
    }
    if (r.tg_username) u.username = r.tg_username;
    if (r.step === 'nudge') {
      u.nudges.push({ kind: (r.detail ?? '').split(' ')[0], at });
      continue;
    }
    if (r.step === 'nudge_off') u.off = true;
    u.lastAt = Math.max(u.lastAt, at);
    const idx = FUNNEL_STEPS.indexOf(r.step as FunnelStep);
    if (idx >= 0 && (u.best === null || idx > FUNNEL_STEPS.indexOf(u.best))) u.best = r.step as FunnelStep;
    if (FAIL_STEPS.has(r.step)) {
      u.lastFail = { step: r.step, detail: r.detail };
      if (u.failsBeforeOk === null) fails.set(u.id, (fails.get(u.id) ?? 0) + 1);
    }
    if (r.step === 'provision_ok' && u.failsBeforeOk === null) u.failsBeforeOk = fails.get(u.id) ?? 0;
  }
  for (const u of by.values()) {
    const li = lastIn.get(u.id);
    if (li) u.lastAt = Math.max(u.lastAt, li);
  }
  return [...by.values()];
}

export const STEP_LABEL: Record<FunnelStep, string> = {
  start: '/start',
  bought_click: '«Я купил сервер»',
  setup_click: '«Настроить»',
  ip_ok: 'прислал IP',
  preflight_ok: 'сервер ответил',
  password_ok: 'пароль',
  token_ok: 'токен',
  provision_click: '«Поднять VPN»',
  provision_ok: '✅ узел поднят',
};

/** Где остановился — словами, для списка ушедших. */
export function stuckAt(u: UserState): string {
  if (!u.best) return 'вне воронки';
  if (u.best === 'setup_click' || u.best === 'bought_click') {
    return u.lastFail?.step === 'ip_rejected' ? 'не смог прислать IP' : 'не прислал IP';
  }
  if (u.best === 'ip_ok') return 'сервер не отвечал';
  if (u.best === 'provision_click') return 'установка упала';
  if (u.best === 'start') return 'после /start';
  return 'после шага ' + STEP_LABEL[u.best];
}

const who = (u: UserState) => (u.username ? '@' + u.username : String(u.id));

function ago(ms: number): string {
  const h = Math.round(ms / 3600_000);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн. назад`;
}

/** Текст для /funnel. Окно — по дате прихода человека. */
export function funnelReport(days = 30, now = Date.now()): string {
  const from = now - days * 24 * 3600_000;
  const users = loadUserStates().filter((u) => u.firstAt >= from);
  if (users.length === 0) return `За ${days} дн. в станок никто не заходил.`;

  const reached = (s: FunnelStep) =>
    users.filter((u) => u.best && FUNNEL_STEPS.indexOf(u.best) >= FUNNEL_STEPS.indexOf(s)).length;
  const buyOpen = (
    db
      .prepare(`SELECT COUNT(DISTINCT tg_user_id) c FROM events WHERE step = 'buy_open' AND created_at >= datetime(?, 'unixepoch')`)
      .get(Math.floor(from / 1000)) as { c: number }
  ).c;

  const lines = [`📊 Воронка за ${days} дн. — ${users.length} чел.`, ''];
  for (const s of FUNNEL_STEPS) {
    lines.push(`${STEP_LABEL[s]} — ${reached(s)}`);
    if (s === 'start' && buyOpen) lines.push(`   открыли «Как купить» — ${buyOpen}`);
  }
  const ok = users.filter((u) => u.failsBeforeOk !== null);
  const clean = ok.filter((u) => u.failsBeforeOk === 0).length;
  lines.push('', `С первого раза, без единой ошибки: ${clean} из ${ok.length}`);

  const gone = users.filter((u) => u.failsBeforeOk === null && now - u.lastAt >= GONE_AFTER_MS);
  if (gone.length) {
    const groups = new Map<string, UserState[]>();
    for (const u of gone) groups.set(stuckAt(u), [...(groups.get(stuckAt(u)) ?? []), u]);
    lines.push('', `🚪 Ушли (3+ сут без движения, узел не подняли): ${gone.length}`);
    for (const [where, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`• ${where}: ${list.length}`);
    }
    const lastGone = [...gone].sort((a, b) => b.lastAt - a.lastAt).slice(0, 8);
    lines.push('Последние: ' + lastGone.map((u) => `${who(u)} (${stuckAt(u)})`).join(', '));
  }

  const inProgress = users
    .filter((u) => u.failsBeforeOk === null && now - u.lastAt < GONE_AFTER_MS)
    .sort((a, b) => b.lastAt - a.lastAt);
  if (inProgress.length) {
    lines.push('', `⏳ Сейчас в процессе: ${inProgress.length}`);
    for (const u of inProgress.slice(0, 10)) lines.push(`• ${who(u)} — ${stuckAt(u)}, ${ago(now - u.lastAt)}`);
  }

  const inputs = rejectedIpInputs(8);
  if (inputs.length) {
    lines.push('', 'Что присылали вместо IP:');
    for (const i of inputs) lines.push(`• «${(i.text ?? '').slice(0, 60)}» ×${i.times}`);
  }
  lines.push('', '/chat @ник — весь диалог человека · /funnel 7 — за неделю');
  return lines.join('\n');
}
