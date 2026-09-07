import { db } from './db.js';

// Журнал шагов человека в боте: где он был и где отвалился.
//
// Зачем: до 15.08.2026 узнать, что у человека не получилось, можно было только попросив
// у него скриншоты. Теперь путь каждого виден в базе, и воронка считается по факту,
// а не по догадкам.
//
// ⚠️ ЖЁСТКОЕ ПРАВИЛО: в `detail` не попадают секреты. Ни root-пароль, ни токен бота,
// ни текст сообщений целиком. Только шаг, IP и причина отказа.

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id  INTEGER NOT NULL,
    tg_username TEXT,
    step        TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_user ON events(tg_user_id);
  CREATE INDEX IF NOT EXISTS idx_events_step ON events(step);
`);

// Порядок = порядок воронки. По нему считается, до какой ступени человек дошёл.
export const FUNNEL_STEPS = [
  'start', // нажал /start
  'bought_click', // «Я купил сервер»
  'setup_click', // «Настроить» — начало ввода данных
  'ip_ok', // прислал синтаксически годный IP
  'preflight_ok', // сервер ответил на 22 — главный порог
  'password_ok', // отдал root-пароль
  'token_ok', // отдал токен бота-продавца
  'provision_click', // нажал «Поднять VPN»
  'provision_ok', // узел поднят
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

// Шаги вне воронки — это причины отвала, а не ступени.
export type SideStep =
  | 'instr_open'
  | 'ip_rejected'
  | 'ip_taken'
  | 'preflight_fail'
  | 'retry_click'
  | 'newip_click'
  | 'provision_fail'
  // Токен не спрашивали — у владельца уже есть готовый бот, этот сервер идёт
  // доп. локацией в него (см. onboarding.ts, фикс 409 от дублей-ботов 25.08).
  | 'secondary_node'
  // Прошлый primary владельца оказался физически недоступен — новый сервер занял
  // его место, старый снят с primary/ready (см. onboarding.ts, фикс 07.09).
  | 'primary_replaced'
  // Telegram отверг токен (401) — отозван в @BotFather. Раньше это никак не отслеживалось
  // и кончалось вечным циклом перезапусков бота-продавца (см. bot-token.ts, инцидент 07.09).
  | 'token_invalid'
  | 'token_updated'
  | 'token_update_fail'
  // Прислали токен, уже занятый другим владельцем (списан из инструкции/чужого видео) —
  // два процесса с одним токеном валят друг друга (409 Conflict), ловим до установки.
  | 'token_taken'
  // Свободный текст в чате со станком, вне мастера настройки — чтобы видеть, как люди
  // на самом деле пользуются ботом (просьба 07.09). Секреты сюда не попадают: шаги
  // с паролем и токеном обрабатывает мастер, до этого журнала они не доходят.
  | 'chat_message';

export interface EventRow {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  step: string;
  detail: string | null;
  created_at: string;
}

export function logEvent(
  user: { id: number; username?: string },
  step: FunnelStep | SideStep,
  detail?: string,
): void {
  try {
    db.prepare(
      'INSERT INTO events (tg_user_id, tg_username, step, detail) VALUES (?, ?, ?, ?)',
    ).run(user.id, user.username ?? null, step, detail ?? null);
  } catch {
    /* журнал не должен ронять бота */
  }
}

/** Было ли такое событие у этого человека за последние N часов.
 *  Нужно, чтобы не долбить одним и тем же алертом на каждом проходе монитора: состояние
 *  берётся из БД, а не из памяти процесса — иначе оно обнуляется на каждом деплое станка
 *  (эту грабли в проекте уже ловили с offlineNodes, см. db.ts::last_health_ok). */
export function hadRecentEvent(tgUserId: number, step: FunnelStep | SideStep, withinHours: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM events
        WHERE tg_user_id = ? AND step = ? AND created_at > datetime('now', ?)
        LIMIT 1`,
    )
    .get(tgUserId, step, `-${withinHours} hours`);
  return row !== undefined;
}

// Весь путь одного человека — по @username или по telegram id.
export function userTimeline(who: string): EventRow[] {
  const asId = Number(who);
  if (Number.isFinite(asId) && asId > 0) {
    return db
      .prepare('SELECT * FROM events WHERE tg_user_id = ? ORDER BY id')
      .all(asId) as EventRow[];
  }
  const uname = who.replace(/^@/, '');
  return db
    .prepare('SELECT * FROM events WHERE tg_username = ? COLLATE NOCASE ORDER BY id')
    .all(uname) as EventRow[];
}

// Сколько РАЗНЫХ людей дошло до каждой ступени.
export function funnel(): { step: string; users: number }[] {
  return FUNNEL_STEPS.map((step) => ({
    step,
    users: (
      db.prepare('SELECT COUNT(DISTINCT tg_user_id) c FROM events WHERE step = ?').get(step) as {
        c: number;
      }
    ).c,
  }));
}

// Причины отвала с частотой — что чинить следующим.
export function dropReasons(): { step: string; detail: string | null; times: number }[] {
  return db
    .prepare(
      `SELECT step, detail, COUNT(*) times FROM events
        WHERE step IN ('ip_rejected','ip_taken','preflight_fail','provision_fail')
        GROUP BY step, detail ORDER BY times DESC`,
    )
    .all() as { step: string; detail: string | null; times: number }[];
}

// Последние люди, которые что-то делали в боте, и докуда дошли.
export function recentUsers(limit = 20): { user: string; last: string; step: string; at: string }[] {
  return db
    .prepare(
      `SELECT tg_user_id, tg_username, step, created_at FROM events
        WHERE id IN (SELECT MAX(id) FROM events GROUP BY tg_user_id)
        ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r: any) => ({
      user: r.tg_username ? '@' + r.tg_username : String(r.tg_user_id),
      last: String(r.tg_user_id),
      step: r.step,
      at: r.created_at,
    }));
}
