// Тихий бэкап (19.10, по претензии владельца: «2 дня подряд шум в боте вместо нормальной информации»).
//
// Правило, которое он сам выбрал: КРИТИЧНОЕ шлём сразу, ПРЕДУПРЕЖДЕНИЯ — раз в неделю одной сводкой.
// Сбой бэкапа настроек — предупреждение, а не авария: VPN у клиентов работает, под угрозой только
// копия настроек бота-продавца. Поэтому здесь никаких мгновенных сообщений: ни про новый сбой, ни про
// «починился». Мгновенными остаются «узел недоступен», «токен отозван», «провижининг упал» (index.ts).
//
// Что было не так раньше: полный список слался при КАЖДОМ рестарте станка и каждые сутки без
// изменений — узлы с умершим паролем падали годами и «сообщались» заново.
// Чистая функция, без БД и сети — состояние хранит вызывающий.

export interface BackupFailure {
  id: number;
  /** «ip, @ник» — для текста. */
  who: string;
  detail: string;
}

export interface FailEntry {
  /** Сколько прогонов подряд узел падал. */
  streak: number;
  /** Мы уже сообщали об этом узле как о сломанном. */
  alerted: boolean;
  who: string;
}

export interface AlertState {
  failing: Record<string, FailEntry>;
  /** Когда последний раз слали недельную сводку (мс). */
  lastDigest: number;
}

export const WEEK_MS = 7 * 24 * 3_600_000;

export function emptyAlertState(): AlertState {
  return { failing: {}, lastDigest: 0 };
}

/** Постоянный сбой (неверный пароль, сервера нет) сообщаем сразу; временный (таймаут, сеть) —
 *  только если повторился в двух прогонах подряд, иначе это просто чужой вайфай. */
export function isPermanent(detail: string): boolean {
  return /authentication methods failed|all configured authentication|permission denied|no route to host/i.test(detail);
}

export function planBackupAlert(
  prev: AlertState,
  current: BackupFailure[],
  now: number,
): { next: AlertState; text: string | null } {
  const next: AlertState = { failing: {}, lastDigest: prev.lastDigest };
  for (const f of current) {
    const key = String(f.id);
    const streak = (prev.failing[key]?.streak ?? 0) + 1;
    // «Устойчивый» сбой: постоянный по типу (пароль) либо повторился в двух прогонах подряд.
    // Разовый таймаут в сводку не попадает — это просто чужой вайфай.
    next.failing[key] = { streak, alerted: isPermanent(f.detail) || streak >= 2, who: f.who };
  }
  const stuck = Object.entries(next.failing).filter(([, e]) => e.alerted);

  // Отсчёт недели начинается с первого прогона, чтобы сводка не прилетела сразу после выката.
  if (prev.lastDigest === 0) {
    next.lastDigest = now;
    return { next, text: null };
  }
  if (now - prev.lastDigest >= WEEK_MS) {
    next.lastDigest = now;
    if (stuck.length) {
      const list = stuck.map(([k, e]) => `#${k} (${e.who})`).join(', ');
      return { next, text: `📋 Сводка за неделю: бэкап настроек не снимается с ${stuck.length} узлов — ${list}. Это предупреждение, не авария: VPN у клиентов работает.` };
    }
  }
  return { next, text: null };
}
