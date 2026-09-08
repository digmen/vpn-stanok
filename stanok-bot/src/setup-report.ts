import { NodeSSH } from 'node-ssh';
import { SSH } from './constants.js';
import { decrypt } from './crypto.js';
import { getReadyNodes, type NodeRow } from './db.js';

/**
 * Где владельцы спотыкаются, настраивая оплату картой.
 *
 * Зачем: до нас доезжает «не работает», а что человек сделал не так — видно только в тот
 * момент, когда он это делает. Бот-продавец записывает такие моменты у себя
 * (seller-bot/src/setup-log.ts), а станок собирает их со всех узлов в одну картину:
 * по ней чинятся инструкции и сам интерфейс, вместо догадок по пересказу.
 *
 * Ничего на узлах не меняем — только читаем три файла. Секретов в них нет по построению:
 * бот пишет вид события и безобидную деталь, но никогда сам ключ.
 */

const DATA = '/root/seller-bot-data';

export interface SetupRecord {
  at: number;
  event: string;
  detail?: string;
}

export interface NodeSetup {
  nodeId: number;
  who: string;
  ok: boolean;
  reason?: string;
  hasKey: boolean;
  bound: number;
  packages: number;
  enabled: boolean;
  /** Приходили ли вообще события от Tribute — это и есть проверка «вставлен ли адрес». */
  webhookSeen: boolean;
  badSignatures: number;
  records: SetupRecord[];
}

/** Понятные названия событий: журнал читает человек, а не машина. */
export const EVENT_TITLES: Record<string, string> = {
  'key-link': 'прислал ссылку вместо ключа',
  'key-bot-token': 'прислал токен бота вместо ключа',
  'key-short': 'скопировал ключ не целиком',
  'key-invalid': 'Tribute не принял ключ',
  'key-network': 'ключ не удалось проверить (связь)',
  'key-ok': 'ключ принят',
  'bind-clash': 'один товар на два тарифа',
  'bind-empty': 'в Tribute нет товаров',
  'bind-gone': 'выбранный товар исчез',
  'bind-ok': 'тариф привязан',
  'bind-off': 'привязку снял',
  enabled: 'включил приём',
  disabled: 'выключил приём',
  'selfcheck-ok': 'самопроверка прошла',
  'selfcheck-fail': 'самопроверка не прошла',
  badsig: 'стучатся с чужой подписью',
  'test-event': 'тестовый запрос из Tribute дошёл',
  'paid-unbound': 'оплатили непривязанный товар',
  'paid-ok': 'оплата картой прошла',
};

/** Заминки — то, ради чего всё и затевалось. Успехи в сводке не шумят. */
export function isProblem(event: string): boolean {
  return (
    event.startsWith('key-') && event !== 'key-ok'
      ? true
      : ['bind-clash', 'bind-empty', 'bind-gone', 'selfcheck-fail', 'badsig', 'paid-unbound'].includes(event)
  );
}

async function readNode(n: NodeRow): Promise<NodeSetup> {
  const base: NodeSetup = {
    nodeId: n.id,
    who: n.tg_username ? '@' + n.tg_username : String(n.tg_user_id),
    ok: false,
    hasKey: false,
    bound: 0,
    packages: 0,
    enabled: false,
    webhookSeen: false,
    badSignatures: 0,
    records: [],
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: n.server_ip,
      username: SSH.USERNAME,
      password: decrypt(n.root_password_enc),
      port: SSH.PORT,
      readyTimeout: SSH.READY_TIMEOUT_MS,
      tryKeyboard: true,
    });
    // Одним заходом: настройки, статус приёма и журнал заминок. Разделитель — чтобы
    // отличить пустой файл от отсутствующего, не делая трёх подключений подряд.
    const res = await ssh.execCommand(
      `cat ${DATA}/settings.json 2>/dev/null || echo '{}'; echo '###'; ` +
        `cat ${DATA}/tribute-status.json 2>/dev/null || echo '{}'; echo '###'; ` +
        `tail -100 ${DATA}/setup-log.jsonl 2>/dev/null || true`,
    );
    const [rawSettings, rawStatus, rawLog] = res.stdout.split('###');
    const settings = JSON.parse(rawSettings.trim() || '{}') as {
      packages?: unknown[];
      tribute?: { enabled?: boolean; apiKey?: string | null; products?: unknown[] };
    };
    const status = JSON.parse(rawStatus.trim() || '{}') as { lastEventAt?: number; rejected?: number };
    return {
      ...base,
      ok: true,
      hasKey: Boolean(settings.tribute?.apiKey),
      bound: settings.tribute?.products?.length ?? 0,
      packages: settings.packages?.length ?? 0,
      enabled: Boolean(settings.tribute?.enabled),
      webhookSeen: status.lastEventAt !== undefined,
      badSignatures: status.rejected ?? 0,
      records: (rawLog ?? '')
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as SetupRecord];
          } catch {
            return [];
          }
        }),
    };
  } catch (e) {
    return { ...base, reason: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
  } finally {
    ssh.dispose();
  }
}

export async function collectSetup(): Promise<NodeSetup[]> {
  const nodes = getReadyNodes().filter((n) => n.is_primary === 1);
  return Promise.all(nodes.map(readNode));
}

function when(at: number): string {
  const d = new Date(at);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Куда человек дошёл — одной строкой, и следующий шаг, если он застрял. */
function stage(s: NodeSetup): string {
  if (!s.hasKey) return '⚪️ не начинал: ключ не введён';
  if (s.bound === 0) return '🟡 ключ есть, тарифы не привязаны';
  if (!s.enabled) return `🟡 привязано ${s.bound} из ${s.packages}, приём выключен`;
  if (!s.webhookSeen) {
    return s.badSignatures > 0
      ? `🔴 приём включён, но приходят чужие подписи (${s.badSignatures}) — ключ не от того кабинета`
      : '🟡 приём включён, но от Tribute не приходило ничего — адрес в кабинете не вставлен';
  }
  return `🟢 работает, привязано ${s.bound} из ${s.packages}`;
}

export function formatSetupReport(rows: NodeSetup[]): string {
  if (rows.length === 0) return 'Готовых узлов нет.';
  const out: string[] = ['💳 Настройка оплаты картой у владельцев', ''];
  const totals = new Map<string, number>();

  for (const s of rows) {
    out.push(`#${s.nodeId} ${s.who}`);
    if (!s.ok) {
      out.push(`  🔴 не смог прочитать: ${s.reason}`);
      out.push('');
      continue;
    }
    out.push('  ' + stage(s));
    const problems = s.records.filter((r) => isProblem(r.event));
    for (const r of problems) totals.set(r.event, (totals.get(r.event) ?? 0) + 1);
    // Последние заминки — с временем: по ним видно, бился человек только что или неделю назад.
    for (const r of problems.slice(-5)) {
      out.push(`  • ${when(r.at)} ${EVENT_TITLES[r.event] ?? r.event}${r.detail ? ` (${r.detail})` : ''}`);
    }
    out.push('');
  }

  if (totals.size > 0) {
    out.push('Чаще всего спотыкаются:');
    for (const [event, n] of [...totals].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${EVENT_TITLES[event] ?? event} — ${n}`);
    }
  } else {
    out.push('Заминок ни у кого не записано.');
  }
  return out.join('\n');
}
