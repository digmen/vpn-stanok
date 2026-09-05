import { NodeSSH } from 'node-ssh';
import { REMOTE, SSH } from './constants.js';
import { db, type NodeRow } from './db.js';
import { decrypt } from './crypto.js';

// Сбор выручки узлов — основание для процента владельца станка.
//
// Зачем: договорённость «узел платит % с продаж» держится на цифре, которую
// называет сам узел. Своих данных о его продажах у станка не было вообще:
// `events` — это только воронка подключения (дошёл ли человек до provision_ok),
// а продажи лежат в `subs.json` НА СЕРВЕРЕ УЗЛА.
//
// 🔴 06.09: раньше это применялось молча ко ВСЕМ узлам разом (общий 5%) — но
// договорённость такого рода в реальности была только с одним человеком
// (Александром, 10%, отдельная история, уже вне этой базы). Для остальных
// владельцев узлов такой договорённости никто не заключал: заходить к ним по
// SSH раз в 6 часов читать их подписки и слать себе алерт о их продажах —
// не страховка, а слежка без согласия. Теперь трогаются только узлы, которым
// явно включили revenue_share_percent (см. db.ts::getRevenueShareNodes/
// setRevenueSharePercent, команда /revenue share).
//
// 🔒 Читаем молча и только на чтение: один `cat` файла по SSH. Ничего не
// пишем, ничего не перезапускаем, в боте узла не появляется ни кнопки, ни
// сообщения. Это страховка владельца, а не отчётность перед узлом.
//
// 🔴 Копим у себя, а не считаем на лету: файл на узле живёт своей жизнью —
// узел может его почистить, потерять сервер, переустановить бота. Раз увиденная
// продажа остаётся в базе станка навсегда.

const SUBS_PATH = `${REMOTE.SELLER_DATA_DIR}/subs.json`;
const DAY_MS = 86_400_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS node_sales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL,
    fingerprint TEXT    NOT NULL,
    stars       INTEGER NOT NULL DEFAULT 0,
    days        INTEGER,
    bought_at   INTEGER,
    seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(node_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_sales_node ON node_sales(node_id);
`);

export interface Sale {
  fingerprint: string;
  stars: number;
  days?: number;
  boughtAt?: number;
}

/**
 * Разбирает subs.json продавца. Формат пережил три поколения (см. подробный
 * комментарий в seller-bot/src/subscriptions.ts) — здесь нас интересуют только
 * деньги и опознание записи, поэтому читаем мягко и мусор просто пропускаем.
 *
 * Отпечаток = первый публичный ключ + момент покупки. Своего id у подписки нет,
 * а эта пара уникальна: ключ генерируется на сервере при выдаче.
 */
export function parseSales(json: string): Sale[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: Sale[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;

    // v3 — массив пиров; v1/v2 — единственный pubkey
    let key = '';
    if (Array.isArray(r.peers)) {
      const first = (r.peers as Record<string, unknown>[]).find((p) => p && typeof p === 'object');
      key = String(first?.pubkey ?? '');
    } else if (typeof r.pubkey === 'string') {
      key = r.pubkey;
    }
    if (!key) continue;

    const boughtAt = Number(r.boughtAt);
    out.push({
      fingerprint: `${key}:${Number.isFinite(boughtAt) ? boughtAt : 0}`,
      // Пробный период — это тоже запись в файле, но денег там нет.
      stars: Number.isFinite(Number(r.stars)) ? Number(r.stars) : 0,
      ...(Number.isFinite(Number(r.days)) ? { days: Number(r.days) } : {}),
      ...(Number.isFinite(boughtAt) ? { boughtAt } : {}),
    });
  }
  return out;
}

/** Сохраняет продажи узла. Возвращает, сколько записей увидели впервые. */
export function storeSales(nodeId: number, sales: Sale[]): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO node_sales (node_id, fingerprint, stars, days, bought_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let added = 0;
  const tx = db.transaction((rows: Sale[]) => {
    for (const s of rows) {
      const info = ins.run(nodeId, s.fingerprint, s.stars, s.days ?? null, s.boughtAt ?? null);
      if (info.changes > 0) added++;
    }
  });
  tx(sales);
  return added;
}

/** Один заход на узел: прочитать файл подписок. Ничего на сервере не меняет. */
async function fetchSubsJson(host: string, password: string): Promise<string> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host,
    username: SSH.USERNAME,
    password,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true,
  });
  try {
    // `2>/dev/null || echo []` — узел мог ещё ничего не продать, файла нет.
    const res = await ssh.execCommand(`cat ${SUBS_PATH} 2>/dev/null || echo '[]'`);
    return res.stdout || '[]';
  } finally {
    ssh.dispose();
  }
}

export interface SyncResult {
  nodeId: number;
  ok: boolean;
  added: number;
  reason?: string;
}

export async function syncNode(node: NodeRow): Promise<SyncResult> {
  try {
    const json = await fetchSubsJson(node.server_ip, decrypt(node.root_password_enc));
    const added = storeSales(node.id, parseSales(json));
    return { nodeId: node.id, ok: true, added };
  } catch (e) {
    return {
      nodeId: node.id,
      ok: false,
      added: 0,
      reason: (e instanceof Error ? e.message : String(e)).slice(0, 120),
    };
  }
}

export interface NodeRevenue {
  nodeId: number;
  username: string | null;
  serverIp: string;
  sharePercent: number;
  /** Продажи за период (только платные, пробные не считаются). */
  weekStars: number;
  weekCount: number;
  totalStars: number;
  totalCount: number;
  trials: number;
}

/** Только узлы с явно включённой долей — см. комментарий выше зачем. */
export function revenueReport(days = 7, now = Date.now()): NodeRevenue[] {
  const since = now - days * DAY_MS;
  const rows = db
    .prepare(
      `SELECT n.id AS nodeId, n.tg_username AS username, n.server_ip AS serverIp,
              n.revenue_share_percent AS sharePercent,
              COALESCE(SUM(CASE WHEN s.stars > 0 AND COALESCE(s.bought_at, 0) >= ? THEN s.stars END), 0) AS weekStars,
              COALESCE(SUM(CASE WHEN s.stars > 0 AND COALESCE(s.bought_at, 0) >= ? THEN 1 END), 0)       AS weekCount,
              COALESCE(SUM(CASE WHEN s.stars > 0 THEN s.stars END), 0)                                   AS totalStars,
              COALESCE(SUM(CASE WHEN s.stars > 0 THEN 1 END), 0)                                         AS totalCount,
              COALESCE(SUM(CASE WHEN s.stars = 0 THEN 1 END), 0)                                         AS trials
         FROM nodes n
         LEFT JOIN node_sales s ON s.node_id = n.id
        WHERE n.revenue_share_percent IS NOT NULL
        GROUP BY n.id
        ORDER BY totalStars DESC, n.id`,
    )
    .all(since, since) as NodeRevenue[];
  return rows;
}

export function commission(stars: number, percent: number): number {
  return Math.round((stars * percent) / 100);
}
