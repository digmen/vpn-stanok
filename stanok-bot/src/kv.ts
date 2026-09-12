import { db } from './db.js';

// Мелкие настройки станка, которые админ меняет из чата, без деплоя
// (промокод хостинга, текст бонусов, момент включения напоминаний).

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function kvGet(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

/** Записывает, только если ключа ещё нет; возвращает то, что лежит в итоге. */
export function kvInit(key: string, value: string): string {
  db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(key, value);
  return kvGet(key)!;
}
