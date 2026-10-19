// Тихие алерты о бэкапе (19.10, по претензии владельца: «2 дня подряд шум в боте вместо нормальной информации»).
//
// Что было не так: полный список упавших узлов слался (а) при КАЖДОМ рестарте станка — деплоев за
// день бывает много — и (б) каждые сутки, даже когда ничего не поменялось: узлы с умершим паролем
// или удалённым сервером падали годами и каждый день заново «сообщались».
//
// Теперь сообщаем только об ИЗМЕНЕНИИ: новый сбой, узел починился, и раз в неделю — одна короткая
// сводка о том, что всё ещё лежит. Чистая функция, без БД и сети — состояние хранит вызывающий.

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
  const fresh: string[] = [];

  for (const f of current) {
    const key = String(f.id);
    const old = prev.failing[key];
    const streak = (old?.streak ?? 0) + 1;
    let alerted = old?.alerted ?? false;
    if (!alerted && (isPermanent(f.detail) || streak >= 2)) {
      alerted = true;
      fresh.push(`#${f.id} (${f.who}): ${f.detail.split('\n')[0]!.slice(0, 120)}`);
    }
    next.failing[key] = { streak, alerted, who: f.who };
  }

  const recovered = Object.entries(prev.failing)
    .filter(([k, e]) => e.alerted && !next.failing[k])
    .map(([k, e]) => `#${k} (${e.who})`);

  const lines: string[] = [];
  if (fresh.length) lines.push(`⚠️ Бэкап настроек: новые сбои (${fresh.length}):\n${fresh.join('\n')}`);
  if (recovered.length) lines.push(`✅ Бэкап снова работает: ${recovered.join(', ')}`);

  const stuck = Object.entries(next.failing).filter(([, e]) => e.alerted);
  // Отсчёт недели начинается с первого прогона в тихом режиме, чтобы сводка не прилетела сразу.
  if (prev.lastDigest === 0) {
    next.lastDigest = now;
  } else if (!lines.length && stuck.length && now - prev.lastDigest >= WEEK_MS) {
    next.lastDigest = now;
    lines.push(`📋 Раз в неделю: бэкап не снимается с ${stuck.length} узлов — ${stuck.map(([k]) => '#' + k).join(', ')}.`);
  }

  return { next, text: lines.length ? lines.join('\n\n') : null };
}
