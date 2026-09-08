import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Api } from 'grammy';

/**
 * Рассылка владельцам с возможностью отката.
 *
 * 🔴 08.09, живой случай: разослал оповещение и получил «удали у всех». Идентификаторы
 * отправленных сообщений нигде не сохранялись, поэтому удалить их точно было нечем —
 * пришлось искать перебором номеров, что и медленно, и рискует зацепить чужое сообщение.
 * Теперь номер каждого отправленного сообщения записывается сразу, и откат — одна команда.
 *
 * Хранится на диске: между отправкой и «удали» проходит время, за которое станок могли
 * перезапустить (деплой, падение), а память процесса этого не переживает.
 */
const FILE = path.resolve('broadcasts.json');
const KEEP = 20;

interface SentMsg {
  chatId: number;
  messageId: number;
}

export interface BroadcastRecord {
  id: string;
  at: number;
  /** Первые строки текста — чтобы в /undo было видно, что именно откатываем. */
  preview: string;
  sent: SentMsg[];
}

function read(): BroadcastRecord[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as BroadcastRecord[]) : [];
  } catch {
    return [];
  }
}

function write(list: BroadcastRecord[]): void {
  try {
    writeFileSync(FILE, JSON.stringify(list.slice(-KEEP), null, 2));
  } catch {
    /* не критично: откат просто не сработает, сама рассылка уже ушла */
  }
}

/** Шлёт текст списку людей и запоминает, что куда ушло. */
export async function broadcast(
  api: Api,
  chatIds: number[],
  text: string,
): Promise<{ record: BroadcastRecord; failed: number[] }> {
  const sent: SentMsg[] = [];
  const failed: number[] = [];
  for (const chatId of chatIds) {
    try {
      const m = await api.sendMessage(chatId, text);
      sent.push({ chatId, messageId: m.message_id });
    } catch {
      // Заблокировал бота, удалил чат — не повод ронять всю рассылку.
      failed.push(chatId);
    }
  }
  const record: BroadcastRecord = {
    id: String(Date.now()),
    at: Date.now(),
    preview: text.split('\n')[0].slice(0, 60),
    sent,
  };
  const list = read();
  list.push(record);
  write(list);
  return { record, failed };
}

export function lastBroadcast(): BroadcastRecord | undefined {
  return read().at(-1);
}

/** Удаляет сообщения последней рассылки. Возвращает, сколько реально удалено. */
export async function undoLast(api: Api): Promise<{ ok: number; failed: number; preview: string } | null> {
  const list = read();
  const rec = list.pop();
  if (!rec) return null;
  let ok = 0;
  let failed = 0;
  for (const m of rec.sent) {
    try {
      await api.deleteMessage(m.chatId, m.messageId);
      ok++;
    } catch {
      // Старше 48 часов или уже удалено — Telegram откажет, это не ошибка нашей стороны.
      failed++;
    }
  }
  write(list);
  return { ok, failed, preview: rec.preview };
}
