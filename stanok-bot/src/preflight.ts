import net from 'node:net';
import { SSH } from './constants.js';

// Проверка «а есть ли вообще куда стучаться», ДО того как просить у человека root-пароль.
//
// Зачем: из 24 провижинингов 18 упали на том, что станок не смог открыть SSH-сессию.
// Человек к этому моменту уже отдал боту пароль от сервера — впустую и небезопасно.
// Открытый TCP 22 не гарантирует успех, но закрытый гарантирует провал.

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: 'timeout' | 'refused' | 'unreachable' };

const PREFLIGHT_TIMEOUT_MS = 8_000;

export function checkSshPort(
  host: string,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
  port: number = SSH.PORT,
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (r: PreflightResult): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', (e: NodeJS.ErrnoException) => {
      // ECONNREFUSED — машина есть, sshd не слушает (сервер ещё грузится или порт другой).
      // Остальное (EHOSTUNREACH, ENETUNREACH, EAI_*) — до машины вообще не доехали.
      finish({ ok: false, reason: e.code === 'ECONNREFUSED' ? 'refused' : 'unreachable' });
    });
    socket.connect(port, host);
  });
}

// Текст для человека: что именно не так и что с этим делать. Без слова «таймаут».
export function preflightMessage(host: string, reason: 'timeout' | 'refused' | 'unreachable'): string {
  const head = `🚫 Сервер ${host} не отвечает на подключение по SSH — настроить его я не смогу.\n\n`;
  switch (reason) {
    case 'timeout':
      return (
        head +
        'Почти всегда это одно: НЕ КУПЛЕН ВЫДЕЛЕННЫЙ IP. Без него сервер спрятан за NAT ' +
        'хостинга, и снаружи к нему не достучаться — ни я, ни твои будущие клиенты по VPN.\n\n' +
        'Что делать: в панели хостинга открой свой сервер → добавь услугу «Выделенный IP» ' +
        '(стоит копейки, ~50–65 ₽) → возьми новый адрес оттуда и жми «Проверить снова».'
      );
    case 'refused':
      return (
        head +
        'Адрес живой, но SSH на нём пока не работает. Обычно так бывает первые 5–10 минут ' +
        'после покупки, пока сервер разворачивается.\n\n' +
        'Что делать: подожди 10 минут и жми «Проверить снова». Если не поможет — проверь ' +
        'в панели, что сервер включён и на нём Ubuntu.'
      );
    case 'unreachable':
      return (
        head +
        'Такого адреса нет в сети. Скорее всего, это IP не твоего сервера — например, ' +
        'переписан из инструкции или с опечаткой.\n\n' +
        'Что делать: открой панель хостинга, скопируй IP из карточки своего сервера ' +
        'и пришли его кнопкой «Другой IP».'
      );
  }
}
