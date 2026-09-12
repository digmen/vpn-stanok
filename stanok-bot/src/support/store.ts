import { db } from '../db.js';

// Обращения в техподдержку и вся переписка по ним. Та же база, что у станка, —
// поэтому к каждому обращению сразу видно, докуда человек дошёл в станке.

db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id     INTEGER NOT NULL,
    tg_username    TEXT,
    status         TEXT NOT NULL DEFAULT 'open',   -- open | closed
    stage          TEXT,                            -- где был в станке, когда написал
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    first_reply_at TEXT,
    closed_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_st_user ON support_tickets(tg_user_id);

  CREATE TABLE IF NOT EXISTS support_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL,
    dir        TEXT NOT NULL,        -- in — от человека, out — ответ поддержки
    text       TEXT,
    admin_id   INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sm_ticket ON support_messages(ticket_id);

  -- Сообщение у админа → обращение. По нему ответ «ответом на сообщение» уходит нужному человеку.
  CREATE TABLE IF NOT EXISTS support_routes (
    admin_chat_id INTEGER NOT NULL,
    admin_msg_id  INTEGER NOT NULL,
    ticket_id     INTEGER NOT NULL,
    PRIMARY KEY (admin_chat_id, admin_msg_id)
  );
`);

export interface Ticket {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  status: 'open' | 'closed';
  stage: string | null;
  created_at: string;
  first_reply_at: string | null;
  closed_at: string | null;
}

export function openTicketOf(userId: number): Ticket | undefined {
  return db
    .prepare(`SELECT * FROM support_tickets WHERE tg_user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`)
    .get(userId) as Ticket | undefined;
}

export function createTicket(userId: number, username: string | null, stage: string | null): Ticket {
  const r = db
    .prepare('INSERT INTO support_tickets (tg_user_id, tg_username, stage) VALUES (?, ?, ?)')
    .run(userId, username, stage);
  return getTicket(Number(r.lastInsertRowid))!;
}

export function getTicket(id: number): Ticket | undefined {
  return db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as Ticket | undefined;
}

export function addMessage(ticketId: number, dir: 'in' | 'out', text: string, adminId?: number): void {
  db.prepare('INSERT INTO support_messages (ticket_id, dir, text, admin_id) VALUES (?, ?, ?, ?)').run(
    ticketId,
    dir,
    text,
    adminId ?? null,
  );
  if (dir === 'out') {
    db.prepare(`UPDATE support_tickets SET first_reply_at = COALESCE(first_reply_at, datetime('now')) WHERE id = ?`).run(ticketId);
  }
}

export function closeTicket(id: number): boolean {
  return (
    db.prepare(`UPDATE support_tickets SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'open'`).run(id)
      .changes > 0
  );
}

export function reopenTicket(id: number): void {
  db.prepare(`UPDATE support_tickets SET status = 'open', closed_at = NULL WHERE id = ?`).run(id);
}

export function addRoute(adminChatId: number, adminMsgId: number, ticketId: number): void {
  db.prepare('INSERT OR REPLACE INTO support_routes (admin_chat_id, admin_msg_id, ticket_id) VALUES (?, ?, ?)').run(
    adminChatId,
    adminMsgId,
    ticketId,
  );
}

export function routeOf(adminChatId: number, adminMsgId: number): number | null {
  const r = db
    .prepare('SELECT ticket_id FROM support_routes WHERE admin_chat_id = ? AND admin_msg_id = ?')
    .get(adminChatId, adminMsgId) as { ticket_id: number } | undefined;
  return r?.ticket_id ?? null;
}

export function ticketMessages(ticketId: number): { dir: string; text: string | null; created_at: string }[] {
  return db
    .prepare('SELECT dir, text, created_at FROM support_messages WHERE ticket_id = ? ORDER BY id')
    .all(ticketId) as { dir: string; text: string | null; created_at: string }[];
}

export function ticketsOf(userId: number): Ticket[] {
  return db.prepare('SELECT * FROM support_tickets WHERE tg_user_id = ? ORDER BY id DESC').all(userId) as Ticket[];
}

export function openTickets(): (Ticket & { last_in: string | null; last_out: string | null })[] {
  return db
    .prepare(
      `SELECT t.*,
              (SELECT MAX(created_at) FROM support_messages WHERE ticket_id = t.id AND dir = 'in')  last_in,
              (SELECT MAX(created_at) FROM support_messages WHERE ticket_id = t.id AND dir = 'out') last_out
         FROM support_tickets t WHERE status = 'open' ORDER BY id`,
    )
    .all() as (Ticket & { last_in: string | null; last_out: string | null })[];
}

export function allTickets(): Ticket[] {
  return db.prepare('SELECT * FROM support_tickets ORDER BY id').all() as Ticket[];
}
