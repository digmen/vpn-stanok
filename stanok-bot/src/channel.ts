import type { Api } from 'grammy';
import { config } from './config.js';
import { db } from './db.js';

// Подписка на канал владельца станка перед началом работы (его просьба 13.09:
// «чтобы подписывались перед началом работы в моём боте, и смотреть через станок,
// подписался ли человек»).
//
// Проверка — getChatMember. Telegram отдаёт её только АДМИНАМ канала, поэтому станок
// должен быть в @канале админом (без прав). Пока это не так — проверка «не знаю», и
// человека мы НЕ блокируем: наша недонастройка не должна стоить воронки.
// Прошёл подписку однажды — дальше не спрашиваем, даже если отпишется: это вход, а не надзор.

export type SubStatus = 'yes' | 'no' | 'unknown';

/** Статус участника канала → подписан ли. Чистая функция — под тесты. */
export function isMemberStatus(status: string, isMember?: boolean): boolean {
  if (status === 'creator' || status === 'administrator' || status === 'member') return true;
  if (status === 'restricted') return isMember === true;
  return false; // left, kicked
}

export async function checkSubscribed(api: Api, userId: number): Promise<SubStatus> {
  if (!config.channel) return 'yes';
  try {
    const m = (await api.getChatMember(config.channel, userId)) as { status: string; is_member?: boolean };
    return isMemberStatus(m.status, m.is_member) ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

/** Проходил ли человек вход (или у него уже есть работающий узел — владельцев не трогаем). */
export function passedGate(userId: number): boolean {
  const ev = db
    .prepare(`SELECT 1 FROM events WHERE tg_user_id = ? AND step = 'sub_ok' LIMIT 1`)
    .get(userId);
  if (ev) return true;
  return db.prepare(`SELECT 1 FROM nodes WHERE tg_user_id = ? AND status = 'ready' LIMIT 1`).get(userId) !== undefined;
}

export function channelUrl(): string {
  return 'https://t.me/' + config.channel.replace(/^@/, '');
}
