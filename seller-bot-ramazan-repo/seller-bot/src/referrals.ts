import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './settings.js';

/**
 * Реферальная программа: привёл друга — получил 30% его срока временем.
 *
 * Почему временем, а не скидкой (решение владельца 29.08): скидкой человек
 * может не воспользоваться, а время у него уже есть. И считается оно само:
 * мы нигде не храним деньги, только долю от КУПЛЕННОГО СРОКА. Поэтому смена
 * цен или состава тарифов ничего не ломает — 30% от 30 дней это 9 дней и
 * вчера, и завтра, и это ровно те же 30% денег, потому что срок и цена
 * внутри одного тарифа связаны один в один.
 *
 * ── Где абуз и что с ним сделано ───────────────────────────────────────────
 * 1. Сам себя. Блокируем по tg id, и владельца тоже.
 * 2. Клик без покупки. Начисление висит на успешной оплате, не на переходе.
 * 3. Продать свою ссылку тому, кто и так собирался продлеваться. Привязка
 *    возможна ТОЛЬКО пока у приглашённого нет ни одной покупки, и делается
 *    один раз навсегда — вторая ссылка уже не перебьёт первую.
 * 4. Ферма на продлениях. Считается только ПЕРВАЯ покупка приглашённого.
 * 5. Двойное начисление (ретрай платежа, гонка). Идемпотентность по
 *    telegram_payment_charge_id: один платёж — максимум одно начисление.
 * 6. Возврат звёзд после начисления. refundReferral() снимает выданные дни.
 * 7. Дыра, которую мы не предусмотрели. Потолок на пригласившего (по
 *    умолчанию 365 дней) ограничивает ущерб от любой не найденной сейчас щели.
 *
 * ⚠️ Чего эта схема НЕ закрывает и закрыть не может: второй аккаунт. Человек
 * заводит второй телеграм, приглашает сам себя и покупает там подписку —
 * но он при этом ПЛАТИТ полную цену за вторую подписку и получает 30%
 * временем на первую. При модели «одна подписка — одно устройство» это
 * фактически «взял два устройства, на одном 30% сверху», а не бесплатный
 * VPN. Проверить, что за двумя аккаунтами один человек, мы не можем никак.
 */

const FILE = path.join(config.dataDir, 'referrals.json');
const DAY_MS = 86_400_000;

/** Доля по умолчанию, если настройки почему-то не прочитались. */
export const REFERRAL_SHARE = 0.3;

/** Процент задаёт владелец в боте — фича его, а не наша. */
function share(): number {
  try {
    const r = getSettings().referral;
    if (!r.enabled) return 0;
    return r.percent / 100;
  } catch {
    return REFERRAL_SHARE;
  }
}
/** Потолок начислений на одного пригласившего за всё время, в днях. */
export const REFERRAL_MAX_DAYS = 365;

interface Grant {
  /** Кому начислили. */
  to: number;
  /** За кого начислили. */
  who: number;
  days: number;
  at: number;
  /** Идентификатор платежа — им же гасим повтор и возврат. */
  charge: string;
}

interface State {
  /** приглашённый -> пригласивший. Пишется один раз и не меняется. */
  invitedBy: Record<string, number>;
  /** Кто уже покупал хоть раз (по нему привязка больше невозможна). */
  purchased: number[];
  /** Начисления, по одному на платёж. */
  grants: Grant[];
  /** Накопленные дни у тех, кому их некуда было применить. */
  banked: Record<string, number>;
}

function empty(): State {
  return { invitedBy: {}, purchased: [], grants: [], banked: {} };
}

function load(): State {
  if (!existsSync(FILE)) return empty();
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<State>;
    return {
      invitedBy: raw.invitedBy && typeof raw.invitedBy === 'object' ? raw.invitedBy : {},
      purchased: Array.isArray(raw.purchased) ? raw.purchased.filter((n) => typeof n === 'number') : [],
      grants: Array.isArray(raw.grants) ? (raw.grants as Grant[]) : [],
      banked: raw.banked && typeof raw.banked === 'object' ? raw.banked : {},
    };
  } catch {
    // Битый файл не должен ронять покупки: реферальная программа —
    // надстройка, без неё бот обязан продолжать продавать.
    return empty();
  }
}

function save(s: State): void {
  try {
    writeFileSync(FILE, JSON.stringify(s));
  } catch {
    /* не критично */
  }
}

/** Код в ссылке — просто id пригласившего. Подделывать его бессмысленно:
 *  подставив чужой код, человек дарит бонус чужому, а не себе. */
export function codeFor(userId: number): string {
  return 'r' + String(userId);
}

export function parseCode(payload: string | undefined): number | null {
  if (!payload) return null;
  const m = /^r(\d{1,19})$/.exec(payload.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function inviteLink(botUsername: string, userId: number): string {
  return 'https://t.me/' + botUsername + '?start=' + codeFor(userId);
}

export function hasPurchased(userId: number): boolean {
  return load().purchased.includes(userId);
}

/**
 * Привязка при переходе по ссылке. Возвращает true, только если привязка
 * реально состоялась — вызывающему это нужно, чтобы поздравить человека
 * ровно один раз, а не на каждый /start.
 */
export function bindReferral(
  invited: number,
  inviter: number,
  opts: { isOwner?: boolean } = {},
): boolean {
  if (invited === inviter) return false; // сам себя
  if (opts.isOwner) return false; // владелец через собственный бот не приглашается
  const s = load();
  if (s.invitedBy[String(invited)] !== undefined) return false; // первая ссылка навсегда
  if (s.purchased.includes(invited)) return false; // уже покупал — поздно
  s.invitedBy[String(invited)] = inviter;
  save(s);
  return true;
}

export interface ReferralAward {
  /** Кому начислить дни. */
  inviter: number;
  /** Сколько дней. */
  days: number;
}

/**
 * Отмечает покупку и, если она первая у приглашённого, считает бонус.
 * Ничего не начисляет сама — возвращает намерение, применить его должен
 * вызывающий (он знает, есть ли у пригласившего активная подписка).
 * Разделено намеренно: считать долю и менять чужие подписки — разные
 * обязанности, и вторая умеет падать.
 */
export function registerPurchase(
  buyer: number,
  daysBought: number,
  charge: string,
): ReferralAward | null {
  const s = load();

  // Идемпотентность: тот же платёж второй раз не начисляем никогда.
  if (charge && s.grants.some((g) => g.charge === charge)) return null;

  const firstPurchase = !s.purchased.includes(buyer);
  if (firstPurchase) s.purchased.push(buyer);

  const inviter = s.invitedBy[String(buyer)];
  if (inviter === undefined || !firstPurchase || daysBought <= 0 || share() <= 0) {
    save(s);
    return null;
  }

  const already = s.grants.filter((g) => g.to === inviter).reduce((n, g) => n + g.days, 0);
  const room = Math.max(0, REFERRAL_MAX_DAYS - already);
  const days = Math.min(Math.round(daysBought * share()), room);
  if (days <= 0) {
    save(s);
    return null;
  }

  s.grants.push({ to: inviter, who: buyer, days, at: Date.now(), charge });
  save(s);
  return { inviter, days };
}

/** Возврат звёзд: снимаем то, что начислили за этот платёж. */
export function refundReferral(charge: string): ReferralAward | null {
  const s = load();
  const g = s.grants.find((x) => x.charge === charge);
  if (!g) return null;
  s.grants = s.grants.filter((x) => x.charge !== charge);
  // Если дни лежали в копилке — снимаем оттуда, до нуля и не ниже.
  const key = String(g.to);
  if (s.banked[key]) s.banked[key] = Math.max(0, s.banked[key] - g.days);
  save(s);
  return { inviter: g.to, days: g.days };
}

/** Дни, которые некуда было применить — ждут первой покупки пригласившего. */
export function bankDays(userId: number, days: number): void {
  const s = load();
  const key = String(userId);
  s.banked[key] = (s.banked[key] ?? 0) + days;
  save(s);
}

/** Забрать накопленное (и обнулить) — вызывается в момент покупки. */
export function takeBanked(userId: number): number {
  const s = load();
  const key = String(userId);
  const n = s.banked[key] ?? 0;
  if (n > 0) {
    delete s.banked[key];
    save(s);
  }
  return n;
}

export interface ReferralStats {
  invited: number;
  bought: number;
  daysEarned: number;
  banked: number;
}

export function statsFor(userId: number): ReferralStats {
  const s = load();
  const invited = Object.values(s.invitedBy).filter((v) => v === userId).length;
  const mine = s.grants.filter((g) => g.to === userId);
  return {
    invited,
    bought: mine.length,
    daysEarned: mine.reduce((n, g) => n + g.days, 0),
    banked: s.banked[String(userId)] ?? 0,
  };
}

export const DAY = DAY_MS;
