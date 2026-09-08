import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Промокоды: скидка в процентах от цены тарифа.
 *
 * ── Решения, которые стоит понимать, а не переоткрывать ────────────────────
 * 1. Скидка едет В САМОМ СЧЁТЕ (в payload), а не хранится как «активный код
 *    пользователя». Иначе перезапуск бота (деплой, смена токена, падение)
 *    терял бы применённый код, и человек платил бы полную цену за то, на что
 *    ему пообещали скидку. Telegram хранит payload за нас.
 * 2. Код списывается ТОЛЬКО после успешной оплаты, а не при вводе. Иначе
 *    любой желающий сжигает лимит чужого промокода, ничего не заплатив.
 * 3. Один человек — один раз по одному коду. Без этого код с лимитом 100
 *    выкупается одним и тем же человеком сто раз.
 * 4. Скидка ограничена 90%: «бесплатно» — это не промокод, а подарок, и для
 *    него есть пробный период. Плюс Telegram не принимает счёт дешевле 1⭐.
 */
const FILE = path.join(config.dataDir, 'promos.json');

export interface Promo {
  /** Всегда в верхнем регистре — сравнение регистронезависимое. */
  code: string;
  percent: number;
  /** Сколько раз всего можно использовать. undefined = без ограничения. */
  maxUses?: number;
  /** Кто уже воспользовался — он же счётчик использований. */
  usedBy: number[];
}

export const PROMO_LIMITS = {
  MAX_PERCENT: 90,
  MIN_PERCENT: 1,
  MAX_CODE_LEN: 24,
  MAX_PROMOS: 20,
} as const;

function read(): Promo[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is Promo => !!p && typeof p === 'object')
      .filter((p) => typeof p.code === 'string' && Number.isFinite(p.percent))
      .map((p) => ({
        code: String(p.code).toUpperCase().slice(0, PROMO_LIMITS.MAX_CODE_LEN),
        percent: Number(p.percent),
        ...(Number.isInteger(p.maxUses) && Number(p.maxUses) > 0 ? { maxUses: Number(p.maxUses) } : {}),
        usedBy: Array.isArray(p.usedBy) ? p.usedBy.filter((n) => typeof n === 'number') : [],
      }));
  } catch {
    // Битый файл не должен ронять продажи: промокоды — надстройка, без них
    // бот обязан продолжать продавать по обычной цене.
    return [];
  }
}

function write(list: Promo[]): void {
  try {
    writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch {
    /* не критично */
  }
}

export function allPromos(): Promo[] {
  return read();
}

export function isValidCode(s: string): boolean {
  return /^[A-Za-z0-9_-]{3,24}$/.test(s.trim());
}

export function isValidPromoPercent(n: number): boolean {
  return Number.isInteger(n) && n >= PROMO_LIMITS.MIN_PERCENT && n <= PROMO_LIMITS.MAX_PERCENT;
}

export function addPromo(code: string, percent: number, maxUses?: number): boolean {
  const list = read();
  if (list.length >= PROMO_LIMITS.MAX_PROMOS) return false;
  const up = code.trim().toUpperCase();
  if (list.some((p) => p.code === up)) return false;
  list.push({ code: up, percent, ...(maxUses ? { maxUses } : {}), usedBy: [] });
  write(list);
  return true;
}

export function removePromo(code: string): boolean {
  const list = read();
  const up = code.trim().toUpperCase();
  const next = list.filter((p) => p.code !== up);
  if (next.length === list.length) return false;
  write(next);
  return true;
}

export type PromoCheck =
  | { ok: true; promo: Promo }
  | { ok: false; reason: 'unknown' | 'used' | 'exhausted' };

/** Можно ли этому человеку воспользоваться этим кодом ПРЯМО СЕЙЧАС. */
export function checkPromo(code: string, userId: number): PromoCheck {
  const up = code.trim().toUpperCase();
  const promo = read().find((p) => p.code === up);
  if (!promo) return { ok: false, reason: 'unknown' };
  if (promo.usedBy.includes(userId)) return { ok: false, reason: 'used' };
  if (promo.maxUses !== undefined && promo.usedBy.length >= promo.maxUses) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, promo };
}

/** Цена со скидкой. Не ниже 1⭐ — счёт дешевле Telegram не принимает. */
export function discountedStars(stars: number, percent: number): number {
  return Math.max(1, Math.round(stars * (1 - percent / 100)));
}

/** Списание — строго после успешной оплаты (см. решение 2 в шапке). */
export function markPromoUsed(code: string, userId: number): void {
  const list = read();
  const up = code.trim().toUpperCase();
  const promo = list.find((p) => p.code === up);
  if (!promo || promo.usedBy.includes(userId)) return;
  promo.usedBy.push(userId);
  write(list);
}
