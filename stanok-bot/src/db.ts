import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id        INTEGER NOT NULL,
    tg_username       TEXT,
    server_ip         TEXT NOT NULL,
    root_password_enc TEXT NOT NULL,
    seller_token_enc  TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending_provision',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface NodeRow {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  server_ip: string;
  root_password_enc: string;
  seller_token_enc: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function insertNode(n: {
  tgUserId: number;
  tgUsername?: string;
  serverIp: string;
  rootPasswordEnc: string;
  sellerTokenEnc: string;
}): number {
  const info = db
    .prepare(
      `INSERT INTO nodes (tg_user_id, tg_username, server_ip, root_password_enc, seller_token_enc)
       VALUES (@tgUserId, @tgUsername, @serverIp, @rootPasswordEnc, @sellerTokenEnc)`,
    )
    .run({
      tgUserId: n.tgUserId,
      tgUsername: n.tgUsername ?? null,
      serverIp: n.serverIp,
      rootPasswordEnc: n.rootPasswordEnc,
      sellerTokenEnc: n.sellerTokenEnc,
    });
  return Number(info.lastInsertRowid);
}

export function getNodesByUser(tgUserId: number): NodeRow[] {
  return db
    .prepare('SELECT * FROM nodes WHERE tg_user_id = ? ORDER BY id DESC')
    .all(tgUserId) as NodeRow[];
}

export function getNodeById(id: number): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
}

export function setNodeStatus(id: number, status: string): void {
  db.prepare("UPDATE nodes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}
