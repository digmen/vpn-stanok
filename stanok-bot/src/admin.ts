import { type Api } from 'grammy';
import { config } from './config.js';

// Шлёт сообщение всем админам из ADMIN_IDS (для алертов об ошибках провижининга).
export async function notifyAdmins(api: Api, text: string): Promise<void> {
  for (const id of config.adminIds) {
    try {
      await api.sendMessage(id, text);
    } catch {
      /* админ не начинал диалог с ботом — пропускаем */
    }
  }
}
