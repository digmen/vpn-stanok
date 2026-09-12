import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Разбор упавшей установки VPN на сервере владельца.
 *
 * 🔴 Зачем (11.09, узел #21): установка трижды падала, и в тревогу, и владельцу уходило
 * одно и то же — «tput: No value for $TERM» четыре раза подряд. Это мусор от установщика
 * xray (он раскрашивает вывод и ругается, когда терминала нет), и он занимал всё начало
 * сообщения. Настоящая причина — строка нашего же скрипта — стоит в КОНЦЕ вывода и
 * отрезалась. Владелец ушёл после третьей попытки, сервер удалил, и восстановить причину
 * стало нечем: полный вывод нигде не сохранялся.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../logs/install');
const KEEP_LOGS = 100;

/** Строки, которые ничего не говорят о причине и только вытесняют её из сообщения. */
const NOISE = [/^tput: /, /^\s*$/, /^Warning: apt-key/, /^WARNING: apt does not have a stable CLI/];

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Последние содержательные строки вывода. Берём ХВОСТ, а не начало: скрипт падает на
 * последнем, что успел сделать, и именно там он пишет, почему (`echo ... >&2; exit 1`).
 */
export function meaningfulTail(stderr: string, stdout: string, lines = 6): string {
  const clean = (t: string) =>
    t
      .replace(ANSI, '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => !NOISE.some((re) => re.test(l)));
  const err = clean(stderr);
  // stderr важнее: туда наш скрипт пишет причину. stdout — запасной, если там пусто.
  const pick = err.length > 0 ? err : clean(stdout);
  return pick.slice(-lines).join('\n') || 'скрипт завершился с ошибкой, но ничего не написал';
}

/** Сохраняем ПОЛНЫЙ вывод: сервер владельца могут удалить через минуту, а причина нужна нам. */
export function saveInstallLog(host: string, code: number | null, stdout: string, stderr: string): string | null {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_${host}.log`);
    writeFileSync(file, `host: ${host}\ncode: ${code}\n\n=== STDERR ===\n${stderr}\n\n=== STDOUT ===\n${stdout}\n`);
    // Держим последние KEEP_LOGS: это разбор ошибок, а не архив.
    const all = readdirSync(LOG_DIR).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_LOGS))) rmSync(path.join(LOG_DIR, old), { force: true });
    return file;
  } catch {
    return null;
  }
}

/**
 * Что сказать владельцу. Сырой вывод ему бесполезен и пугает — он видит «tput: …» и
 * понимает только, что всё сломано. Известные причины переводим в действие, которое
 * он может сделать сам; неизвестную честно называем нашей и не вываливаем текст.
 */
export function humanInstallError(detail: string): string {
  if (/сертификат/i.test(detail) && /порт 80/i.test(detail)) {
    return (
      'Не удалось выпустить сертификат для сервера. Обычно это значит, что на сервере уже ' +
      'что-то стоит (сайт, панель) и занимает нужный порт. Нужен чистый сервер без сайтов и панелей — ' +
      'можно переустановить на нём систему у хостера и нажать «Попробовать снова».'
    );
  }
  if (/не указывает на/i.test(detail)) {
    return 'Адрес сервера ещё не успел разойтись по интернету. Подожди 5 минут и нажми «Попробовать снова».';
  }
  if (/apt\/dpkg занят/i.test(detail)) {
    return 'Сервер ещё сам себя обновляет после покупки. Подожди 10 минут и нажми «Попробовать снова».';
  }
  if (/xray.*не поднял|failed|не запустил/i.test(detail)) {
    return 'VPN поставился, но не запустился на этом сервере. Я уже вижу ошибку и разберусь — напишу тебе.';
  }
  return 'Не получилось поставить VPN на этот сервер. Я уже вижу подробности ошибки и разберусь — напишу тебе.';
}
