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

// Миграция 25.08: у владельца теперь МНОГО узлов, но бот-продавец — ОДИН.
// is_primary отмечает узел, на котором реально живёт процесс seller-bot. Остальные
// узлы того же владельца — просто VPN-точки, подключаемые в этот единственный бот
// (см. attach-location.ts). Раньше КАЖДЫЙ узел получал свою копию бота с тем же
// токеном — второй процесс дрался с первым за getUpdates (409 Conflict), ловили
// дважды на живом клиенте 25.08 (Германия, потом Амстердам) прежде чем нашли причину.
// support_key_enc — свой ключ станка к узлу, добавляется вместе с ключом seller-bot
// при подключении: доступ для техподдержки не завязан на пароль, который владелец
// волен сменить в любой момент.
// Миграция 05.09: до этого станок умел ставить только AmneziaWG, протокол
// нигде не хранился (подразумевался единственным). Добавили VLESS+Reality
// (без домена — см. scripts/install-vless-reality.sh) как второй вариант,
// выбираемый в onboarding.ts. DEFAULT 'amneziawg' — все узлы ДО этой миграции
// реально им и являются, менять задним числом нечего.
// Миграция 06.09: раньше собирали продажи и считали комиссию у ВСЕХ узлов разом
// (глобальный COMMISSION_PERCENT=5% в revenue.ts) — фактическая договорённость о
// проценте с продаж была только с Александром, и то отдельная (10%, не 5%, и уже
// вынесена в отдельный форк вне этой базы). Каждому остальному узлу это било
// молчаливым SSH-заходом раз в 6 часов читать его subs.json без всякого согласия
// и ненужным алертом админу. NULL по умолчанию = станок узел вообще не трогает.
for (const sql of [
  `ALTER TABLE nodes ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE nodes ADD COLUMN support_key_enc TEXT`,
  `ALTER TABLE nodes ADD COLUMN protocol TEXT NOT NULL DEFAULT 'amneziawg'`,
  `ALTER TABLE nodes ADD COLUMN revenue_share_percent INTEGER`,
]) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}

export type NodeProtocol = 'amneziawg' | 'vless_reality';

export interface NodeRow {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  server_ip: string;
  root_password_enc: string;
  seller_token_enc: string;
  status: string;
  is_primary: number;
  support_key_enc: string | null;
  protocol: NodeProtocol;
  /** NULL = с владельцем узла нет договорённости о доле с продаж (умолчание для
   *  ВСЕХ узлов) — станок тогда даже не заходит читать его subs.json, см. revenue.ts.
   *  Заполняется только явно, командой /revenue share, на конкретный узел, если
   *  такая договорённость реально есть (06.09 — договорённость такого рода была
   *  только с Александром, и та уже вне этой базы, в отдельном форке). */
  revenue_share_percent: number | null;
  created_at: string;
  updated_at: string;
}

export function insertNode(n: {
  tgUserId: number;
  tgUsername?: string;
  serverIp: string;
  rootPasswordEnc: string;
  sellerTokenEnc: string;
  isPrimary: boolean;
  protocol: NodeProtocol;
}): number {
  const info = db
    .prepare(
      `INSERT INTO nodes (tg_user_id, tg_username, server_ip, root_password_enc, seller_token_enc, is_primary, protocol)
       VALUES (@tgUserId, @tgUsername, @serverIp, @rootPasswordEnc, @sellerTokenEnc, @isPrimary, @protocol)`,
    )
    .run({
      tgUserId: n.tgUserId,
      tgUsername: n.tgUsername ?? null,
      serverIp: n.serverIp,
      rootPasswordEnc: n.rootPasswordEnc,
      sellerTokenEnc: n.sellerTokenEnc,
      isPrimary: n.isPrimary ? 1 : 0,
      protocol: n.protocol,
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
// isPrimary решает вызывающий (onboarding) — здесь только сохраняем.
export function upsertNode(n: {
  tgUserId: number;
  tgUsername?: string;
  serverIp: string;
  rootPasswordEnc: string;
  sellerTokenEnc: string;
  isPrimary: boolean;
  protocol: NodeProtocol;
}): number {
  const existing = findNodeByUserAndIp(n.tgUserId, n.serverIp);
  if (!existing) return insertNode(n);

  db.prepare(
    `UPDATE nodes
        SET tg_username = @tgUsername, root_password_enc = @rootPasswordEnc,
            seller_token_enc = @sellerTokenEnc, is_primary = @isPrimary, protocol = @protocol,
            status = 'pending_provision', updated_at = datetime('now')
      WHERE id = @id`,
  ).run({
    id: existing.id,
    tgUsername: n.tgUsername ?? null,
    rootPasswordEnc: n.rootPasswordEnc,
    sellerTokenEnc: n.sellerTokenEnc,
    isPrimary: n.isPrimary ? 1 : 0,
    protocol: n.protocol,
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

// Живой узел с ботом-продавцом этого владельца — цель, куда attach-location.ts
// подкладывает новые локации. undefined = у владельца ещё нет ни одного бота
// (значит новый узел должен стать primary, а не VPN-точкой).
export function getPrimaryReadyNode(tgUserId: number): NodeRow | undefined {
  return db
    .prepare("SELECT * FROM nodes WHERE tg_user_id = ? AND is_primary = 1 AND status = 'ready' ORDER BY id LIMIT 1")
    .get(tgUserId) as NodeRow | undefined;
}

export function setNodeStatus(id: number, status: string): void {
  db.prepare("UPDATE nodes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function setNodeSupportKey(id: number, supportKeyEnc: string): void {
  db.prepare("UPDATE nodes SET support_key_enc = ?, updated_at = datetime('now') WHERE id = ?").run(supportKeyEnc, id);
}

// Узлы, по которым реально есть договорённость о доле с продаж — только они
// вообще трогаются сбором выручки (см. revenue.ts::collectRevenue). Пусто по
// умолчанию для всех, пока кто-то явно не включит через /revenue share.
export function getRevenueShareNodes(): NodeRow[] {
  return db.prepare('SELECT * FROM nodes WHERE revenue_share_percent IS NOT NULL ORDER BY id').all() as NodeRow[];
}

/** Включает/выключает долю с продаж для узла. null — выключить (снова не трогаем). */
export function setRevenueSharePercent(id: number, percent: number | null): void {
  db.prepare("UPDATE nodes SET revenue_share_percent = ?, updated_at = datetime('now') WHERE id = ?").run(percent, id);
}
