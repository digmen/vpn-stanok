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

// Узел опознаём по паре (tg_user_id + IP), а не по счётчику заявок.
// Иначе каждая повторная попытка плодит новый номер: на 15.08.2026 было 24 номера при 4 живых узлах.
export function findNodeByUserAndIp(tgUserId: number, serverIp: string): NodeRow | undefined {
  return db
    .prepare('SELECT * FROM nodes WHERE tg_user_id = ? AND server_ip = ? ORDER BY id DESC LIMIT 1')
    .get(tgUserId, serverIp) as NodeRow | undefined;
}

// Тот же IP у другого человека = почти наверняка списан из инструкции, а не из своей панели.
// Реальный случай: 95.163.86.120 прислали двое незнакомых людей с разницей в 13 дней.
export function findNodeByIpOfOtherUser(serverIp: string, tgUserId: number): NodeRow | undefined {
  return db
    .prepare('SELECT * FROM nodes WHERE server_ip = ? AND tg_user_id <> ? ORDER BY id DESC LIMIT 1')
    .get(serverIp, tgUserId) as NodeRow | undefined;
}

// Заводит заявку или обновляет существующую (тот же человек + тот же сервер). Возвращает id узла.
export function upsertNode(n: {
  tgUserId: number;
  tgUsername?: string;
  serverIp: string;
  rootPasswordEnc: string;
  sellerTokenEnc: string;
}): number {
  const existing = findNodeByUserAndIp(n.tgUserId, n.serverIp);
  if (!existing) return insertNode(n);

  db.prepare(
    `UPDATE nodes
        SET tg_username = @tgUsername, root_password_enc = @rootPasswordEnc,
            seller_token_enc = @sellerTokenEnc, status = 'pending_provision',
            updated_at = datetime('now')
      WHERE id = @id`,
  ).run({
    id: existing.id,
    tgUsername: n.tgUsername ?? null,
    rootPasswordEnc: n.rootPasswordEnc,
    sellerTokenEnc: n.sellerTokenEnc,
  });
  return existing.id;
}

export function getNodesByUser(tgUserId: number): NodeRow[] {
  return db
    .prepare('SELECT * FROM nodes WHERE tg_user_id = ? ORDER BY id DESC')
    .all(tgUserId) as NodeRow[];
}

export function getNodeById(id: number): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
}

export function getAllNodes(): NodeRow[] {
  return db.prepare('SELECT * FROM nodes ORDER BY id DESC').all() as NodeRow[];
}

export function getReadyNodes(): NodeRow[] {
  return db.prepare("SELECT * FROM nodes WHERE status = 'ready' ORDER BY id").all() as NodeRow[];
}

export function setNodeStatus(id: number, status: string): void {
  db.prepare("UPDATE nodes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}
