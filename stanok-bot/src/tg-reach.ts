import { NodeSSH } from 'node-ssh';
import { SSH } from './constants.js';

// Достаёт ли сервер владельца до Telegram.
//
// 🔴 22.10, живой случай (узел #36, @shklyaew): хостер Citytelecom режет почти все адреса
// Telegram (api.telegram.org с узла — таймаут, обычные сайты открываются). Станок поставил
// VPN и бота, написал «Готово» — а бот физически не мог связаться с Telegram и молчал.
// Человек шесть часов писал в поддержку «бот не отвечает». Теперь это ловится дважды:
// ДО установки (checkTelegramFromServer) и ПОСЛЕ запуска бота (botReachesTelegram).

export type TgReach = 'ok' | 'blocked' | 'unknown';

const MARK = 'TG_HTTP=';

/**
 * Команда для сервера: любой HTTP-ответ от api.telegram.org значит «достаёт» (302/404 тоже),
 * код 000 — не достучался. Запасной путь через wget — на минимальных образах без curl.
 * Если нет ни curl, ни wget — печатаем «none», и вердикт будет «unknown», а не «blocked».
 */
export const TG_REACH_COMMAND =
  'if command -v curl >/dev/null 2>&1; then ' +
  `echo ${MARK}$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.telegram.org/ 2>/dev/null); ` +
  'elif command -v wget >/dev/null 2>&1; then ' +
  `if wget -q -T 10 -t 1 -O /dev/null --server-response https://api.telegram.org/ 2>&1 | grep -q 'HTTP/'; then echo ${MARK}200; else echo ${MARK}000; fi; ` +
  `else echo ${MARK}none; fi`;

/** Разбор вывода TG_REACH_COMMAND. Чистая функция — чтобы тестировать без сервера. */
export function parseTgReach(stdout: string): TgReach {
  const m = stdout.match(new RegExp(`${MARK}(\\w*)`));
  if (!m) return 'unknown';
  const code = m[1];
  if (code === '000') return 'blocked';
  if (/^[1-5]\d\d$/.test(code)) return 'ok';
  return 'unknown'; // «none» или пусто — проверить нечем, это не приговор серверу
}

/** Заходит по SSH и проверяет, отвечает ли Telegram с самого сервера. Любая осечка — 'unknown'. */
export async function checkTelegramFromServer(host: string, password: string): Promise<TgReach> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host,
      username: SSH.USERNAME,
      password,
      port: SSH.PORT,
      readyTimeout: SSH.READY_TIMEOUT_MS,
      tryKeyboard: true,
    });
    const r = await ssh.execCommand(TG_REACH_COMMAND);
    return parseTgReach(r.stdout);
  } catch {
    return 'unknown';
  } finally {
    ssh.dispose();
  }
}

/** Что сказать владельцу: причина не в нём, выход один — другой хостинг. */
export function telegramBlockedMessage(host: string): string {
  return (
    `🚫 Сервер ${host} не достаёт до Telegram.\n\n` +
    'Хостинг этого сервера блокирует соединение с серверами Telegram. Для обычных сайтов это незаметно, ' +
    'но твой бот-продавец работает именно через Telegram: на таком сервере он запустится и будет молчать.\n\n' +
    'Это не твоя ошибка и не настройка, которую можно поправить. Выход один: взять сервер у другого ' +
    'хостинга (первые 7 дней бесплатно) и настроить заново — «Как купить сервер» в главном меню.'
  );
}

/** Ошибка «бот запущен, но до Telegram с узла не достаёт» — отдельный тип, чтобы показать владельцу своё. */
export class TelegramUnreachableError extends Error {
  constructor(detail: string) {
    super(`бот не достаёт до Telegram: ${detail}`);
    this.name = 'TelegramUnreachableError';
  }
}

/** getMe с самого узла. Токен идёт через stdin (curl -K -), а не аргументом — иначе он виден в ps. */
export function getMeConfig(token: string): string {
  return `url = "https://api.telegram.org/bot${token}/getMe"\nsilent\nshow-error\nmax-time = 12\n`;
}

export type BotReach = { ok: true } | { ok: false; reason: 'blocked' | 'rejected' | 'unknown'; detail: string };

/** Разбор ответа getMe, снятого с узла. */
export function parseGetMe(stdout: string, stderr = ''): BotReach {
  if (/"ok"\s*:\s*true/.test(stdout)) return { ok: true };
  if (/"error_code"\s*:\s*401/.test(stdout)) return { ok: false, reason: 'rejected', detail: 'Telegram отверг токен (401)' };
  if (!stdout.trim()) {
    const why = stderr.trim().split('\n').pop() ?? '';
    // Пустой ответ при ошибке curl = соединения нет (таймаут, reset) — это и есть блокировка.
    if (/timed out|timeout|refused|reset|resolve|unreachable|\(28\)|\(7\)|\(35\)|\(56\)|\(6\)/i.test(why)) {
      return { ok: false, reason: 'blocked', detail: why.slice(0, 120) };
    }
    return { ok: false, reason: 'unknown', detail: why.slice(0, 120) || 'пустой ответ' };
  }
  return { ok: false, reason: 'unknown', detail: stdout.slice(0, 120) };
}

/** Проверка из открытой SSH-сессии на узле: достаёт ли бот (с его токеном) до Telegram. */
export async function botReachesTelegram(ssh: NodeSSH, token: string): Promise<BotReach> {
  const r = await ssh.execCommand('curl -K -', { stdin: getMeConfig(token) });
  if (/curl: command not found|not found/i.test(r.stderr) && !r.stdout) {
    return { ok: false, reason: 'unknown', detail: 'на узле нет curl' };
  }
  return parseGetMe(r.stdout, r.stderr);
}
