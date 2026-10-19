import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Sub } from './subscriptions.js';

// Месячный лимит трафика на клиента (заведено 19.10 по просьбе франчайзи: «чтобы можно было
// указать максимум трафика в месяц, например 50 ГБ»).
//
// Считаем только то, что реально можно измерить: у VLESS+WS+TLS каждый клиент в Xray имеет
// метку email=uuid, а Xray ведёт по ней счётчики. Reality/AmneziaWG такой статистики по
// клиентам не дают — их трафик не учитывается и не блокируется.
//
// Состояние на диске, а не в памяти: бот перезапускается (деплой, самообновление), и счёт
// не должен обнуляться — иначе перезапуск дарил бы клиентам лишние гигабайты.
const FILE = path.join(config.dataDir, 'traffic.json');
export const GB = 1024 ** 3;

export interface Usage {
  up: number;
  down: number;
}
export interface TrafficState {
  /** Месяц учёта в UTC, «2026-10». Сменился → счётчики обнуляются, заблокированные оживают. */
  month: string;
  used: Record<string, Usage>; // uuid → байты
  /** Заблокированные за лимит подписки (по первому ключу, см. subId). */
  blocked: string[];
}

export const monthKey = (now = Date.now()): string => new Date(now).toISOString().slice(0, 7);
/** Подписка не имеет своего id — берём публичный ключ первого пира, он не меняется. */
export const subId = (s: Sub): string => s.peers[0]!.pubkey;

export function emptyState(now = Date.now()): TrafficState {
  return { month: monthKey(now), used: {}, blocked: [] };
}

export function readState(now = Date.now()): TrafficState {
  try {
    if (existsSync(FILE)) {
      const r = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<TrafficState>;
      if (r && typeof r.month === 'string' && r.used && typeof r.used === 'object') {
        return { month: r.month, used: r.used, blocked: Array.isArray(r.blocked) ? r.blocked.map(String) : [] };
      }
    }
  } catch {
    /* битый файл — начинаем счёт заново, но не роняем бота */
  }
  return emptyState(now);
}

export function writeState(st: TrafficState): void {
  try {
    writeFileSync(FILE, JSON.stringify(st));
  } catch {
    /* не критично: потеряем один интервал замера */
  }
}

/** Разбор вывода traffic-vless-ws-tls.sh: по строке JSON на клиента. Мусор пропускаем. */
export function parseTrafficLines(stdout: string): { uuid: string; up: number; down: number }[] {
  const out: { uuid: string; up: number; down: number }[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { uuid?: unknown; up?: unknown; down?: unknown };
      const up = Number(o.up);
      const down = Number(o.down);
      if (typeof o.uuid === 'string' && o.uuid && Number.isFinite(up) && Number.isFinite(down) && up >= 0 && down >= 0) {
        out.push({ uuid: o.uuid, up, down });
      }
    } catch {
      /* не наша строка */
    }
  }
  return out;
}

/** Прибавляет приращения; если наступил новый месяц — сначала обнуляет счётчики. */
export function applyDeltas(
  st: TrafficState,
  deltas: { uuid: string; up: number; down: number }[],
  now = Date.now(),
): TrafficState {
  const month = monthKey(now);
  const next: TrafficState = month === st.month ? { ...st, used: { ...st.used } } : { month, used: {}, blocked: st.blocked };
  for (const d of deltas) {
    const cur = next.used[d.uuid] ?? { up: 0, down: 0 };
    next.used[d.uuid] = { up: cur.up + d.up, down: cur.down + d.down };
  }
  return next;
}

/** Сколько израсходовала подписка суммарно по всем своим ключам и локациям. */
export function subUsage(st: TrafficState, s: Sub): Usage {
  let up = 0;
  let down = 0;
  for (const p of s.peers) {
    const u = st.used[p.pubkey];
    if (u) {
      up += u.up;
      down += u.down;
    }
  }
  return { up, down };
}

export type TrafficAction = 'block' | 'unblock' | 'none';

/** Что делать с подпиской: limitGb=0 — лимит выключен (и тогда всех заблокированных возвращаем). */
export function decideAction(limitGb: number, usage: Usage, blocked: boolean): TrafficAction {
  const over = limitGb > 0 && usage.up + usage.down >= limitGb * GB;
  if (over && !blocked) return 'block';
  if (!over && blocked) return 'unblock';
  return 'none';
}

/** Значение заголовка subscription-userinfo — по нему приложение рисует «8,1 ГБ / 50 ГБ» и дату. */
export function userinfoHeader(usage: Usage, limitGb: number, expiresAtMs: number): string {
  const parts = [`upload=${Math.round(usage.up)}`, `download=${Math.round(usage.down)}`];
  if (limitGb > 0) parts.push(`total=${Math.round(limitGb * GB)}`);
  parts.push(`expire=${Math.floor(expiresAtMs / 1000)}`);
  return parts.join('; ');
}

export const humanGb = (bytes: number): string => (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace('.', ',') + ' ГБ';
