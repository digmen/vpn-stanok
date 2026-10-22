import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Api } from 'grammy';
import { config } from './config.js';
import { promoEnabled } from './branding.js';
import { getOwnerId } from './owner.js';

// Разовое сообщение клиенту про франшизу: «хочешь такой же бот?».
//
// 23.10: пассивная кнопка «Заработай на своём VPN так же» в меню — единственный канал, которым
// франшиза росла, и клиент должен был сам её найти. Теперь после первого ключа (пробного или
// купленного) клиент ОДИН РАЗ видит тот же текст прямо в чате. Это открытая реклама от лица
// самого бота-продавца со ссылкой на станок, владелец о ней знает (условия, п. 2а) и может
// убрать её так же, как кнопку: файл white-label в DATA_DIR (branding.ts).
//
// Ссылка несёт метку `src_<id владельца бота>` — станок пишет её в журнал при /start, и видно,
// какие боты реально приводят новых владельцев.
const FILE = path.join(config.dataDir, 'promo-seen.json');

function read(): number[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as number[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function hasSeenPromo(userId: number): boolean {
  return read().includes(userId);
}

export function markPromoSeen(userId: number): void {
  const ids = read();
  if (ids.includes(userId)) return;
  ids.push(userId);
  try {
    writeFileSync(FILE, JSON.stringify(ids));
  } catch {
    /* не критично: худшее — человек увидит сообщение ещё раз */
  }
}

/** Ссылка на станок с меткой, чей бот привёл человека. Параметр start: до 64 символов, [A-Za-z0-9_-]. */
export function promoLink(stanokUrl: string, ownerId: number): string {
  return ownerId ? `${stanokUrl}?start=src_${ownerId}` : stanokUrl;
}

export function promoNudgeText(link: string): string {
  return (
    '💰 Хочешь такой же VPN-бот и зарабатывать на нём? Он собран на VPNForge: сервер и бот ' +
    'настраиваются за пару минут, продавать VPN можно за звёзды Telegram.\n\n' +
    `Подробности: ${link}\n\n` +
    'Это сообщение приходит один раз.'
  );
}

/** Показать разовое сообщение, если оно уместно. Ошибки не пробрасываем: выдачу ключа оно не ломает. */
export async function maybePromoNudge(api: Api, userId: number): Promise<void> {
  try {
    if (!promoEnabled()) return; // белая марка: у оплативших снятие ничего не показываем
    if (userId === getOwnerId()) return; // владельцу про его же бот не рекламируем
    if (hasSeenPromo(userId)) return;
    markPromoSeen(userId); // сначала пометка: сбой отправки не должен превращаться в повторы
    await api.sendMessage(userId, promoNudgeText(promoLink(config.stanokUrl, getOwnerId())), {
      link_preview_options: { is_disabled: true },
    });
  } catch {
    /* реклама — надстройка */
  }
}
