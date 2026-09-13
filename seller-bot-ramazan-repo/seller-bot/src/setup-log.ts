import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Журнал заминок владельца при настройке.
 *
 * Зачем: владельцы настраивают оплату один раз, вслепую, и когда что-то не выходит — до нас
 * доезжает только «не работает». Что именно человек сделал не так, видно ровно в этот момент
 * и больше никогда. Здесь эти моменты записываются, чтобы по ним чинить инструкции и сам
 * интерфейс, а не гадать по пересказу.
 *
 * 🔴 Секретов тут нет и быть не может. Пишется ВИД события и безобидная деталь (длина
 * строки, код ответа, название тарифа) — никогда сам ключ, токен или ссылка с ключом.
 * Файл читает станок по SSH, то есть он покидает сервер владельца: всё, что сюда попадает,
 * надо считать видимым нам.
 */

const FILE = path.join(config.dataDir, 'setup-log.jsonl');
// Держим последние 300 записей: это журнал для разбора ошибок, а не вечная история.
const MAX_LINES = 300;

/** Что случилось. Названия человеческие — их читает станок и показывает как есть. */
export type SetupEvent =
  | 'key-link' // вместо ключа прислали ссылку на товар
  | 'key-bot-token' // вместо ключа — токен бота из BotFather
  | 'key-short' // ключ скопирован не целиком
  | 'key-invalid' // Tribute сказал «не тот ключ»
  | 'key-network' // проверить ключ не удалось (сеть, а не ключ)
  | 'key-ok'
  | 'bind-clash' // один товар пытались привязать к двум тарифам
  | 'bind-empty' // товаров в Tribute нет вообще
  | 'bind-gone' // выбранный товар исчез из Tribute
  | 'bind-ok'
  | 'bind-off' // привязку сняли
  | 'enabled'
  | 'disabled'
  | 'selfcheck-ok'
  | 'selfcheck-fail'
  | 'badsig' // стучатся с неверной подписью — ключ не от того кабинета
  | 'test-event' // тестовый запрос из кабинета Tribute дошёл
  | 'paid-unbound' // оплатили товар, не привязанный ни к одному тарифу
  | 'paid-no-id' // событие без признака покупки — выдачи не было
  | 'selftest' // наша проверка пути: дошла, но ничего не выдавала
  | 'paid-ok';

export interface SetupRecord {
  at: number;
  event: SetupEvent;
  detail?: string;
}

export function logSetup(event: SetupEvent, detail?: string): void {
  try {
    appendFileSync(FILE, JSON.stringify({ at: Date.now(), event, detail } satisfies SetupRecord) + '\n');
    trim();
  } catch {
    /* журнал разбора не должен мешать тому, что он разбирает */
  }
}

function trim(): void {
  try {
    const lines = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES * 2) return; // подрезаем пачкой, а не на каждой записи
    writeFileSync(FILE, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch {
    /* не критично */
  }
}

export function readSetupLog(limit = MAX_LINES): SetupRecord[] {
  if (!existsSync(FILE)) return [];
  try {
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as SetupRecord);
  } catch {
    return [];
  }
}
