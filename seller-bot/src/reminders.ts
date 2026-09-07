import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { allSubs } from './subscriptions.js';

// Напоминание клиенту за N дней до конца подписки.
//
// Зачем: до 08.09 бот молча отзывал ключ в момент истечения (sweepExpired) — человек
// узнавал об окончании тем, что у него просто перестал работать интернет. Это и грубо,
// и прямо теряет деньги владельцу: большинство продлевает, если напомнить заранее.
//
// Кого уже предупредили — держим на диске, а не в памяти процесса: бот перезапускается
// (деплой, смена токена, падение), и in-memory состояние обнулялось бы, а человек получал
// бы одно и то же напоминание каждый час. Тот же урок, что уже усвоен в станке с
// last_health_ok — состояние, от которого зависят внешние сообщения, живёт в файле.
const FILE = path.join(config.dataDir, 'reminders.json');
const DAY_MS = 86_400_000;

/** Ключ привязан к КОНКРЕТНОМУ сроку: продлил подписку — новый expiresAt, новый ключ,
 *  и следующее напоминание придёт как надо, а не «уже отправляли». */
function keyOf(userId: number, expiresAt: number): string {
  return `${userId}:${expiresAt}`;
}

function read(): Record<string, number> {
  if (!existsSync(FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function write(state: Record<string, number>): void {
  try {
    writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* не критично: в худшем случае напоминание придёт повторно */
  }
}

export interface PendingReminder {
  key: string;
  userId: number;
  expiresAt: number;
  /** Сколько полных дней осталось — для текста сообщения. 0 = истекает сегодня. */
  daysLeft: number;
}

/**
 * Кому пора напомнить прямо сейчас: подписка ещё действует, до конца осталось не больше
 * `daysBefore` дней, и этому человеку по этому сроку мы ещё не писали.
 *
 * Подписки без userId пропускаем молча — это записи первого поколения (см. normalizeSub),
 * покупателя в них попросту нет, писать некому.
 */
export function pendingReminders(daysBefore: number, now = Date.now()): PendingReminder[] {
  const state = read();
  const horizon = now + daysBefore * DAY_MS;
  const out: PendingReminder[] = [];
  for (const s of allSubs()) {
    if (s.userId === undefined) continue;
    if (s.expiresAt <= now || s.expiresAt > horizon) continue;
    const key = keyOf(s.userId, s.expiresAt);
    if (state[key] !== undefined) continue;
    out.push({
      key,
      userId: s.userId,
      expiresAt: s.expiresAt,
      daysLeft: Math.floor((s.expiresAt - now) / DAY_MS),
    });
  }
  return out;
}

/** Отмечаем, что написали. Заодно чистим старьё, чтобы файл не рос вечно. */
export function markReminded(key: string, now = Date.now()): void {
  const state = read();
  state[key] = now;
  const cutoff = now - 30 * DAY_MS;
  for (const [k, at] of Object.entries(state)) {
    if (typeof at !== 'number' || at < cutoff) delete state[k];
  }
  write(state);
}
