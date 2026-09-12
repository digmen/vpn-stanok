/**
 * Запуск бота техподдержки (@VPNForgeSupport_bot) — отдельный процесс рядом со станком.
 *   npm run support
 */
import { Api } from 'grammy';
import { config } from '../config.js';
import { createSupportBot, remindUnanswered } from './bot.js';

if (!config.supportBotToken) {
  console.error('SUPPORT_BOT_TOKEN не задан — бот поддержки не запускаю.');
  process.exit(1);
}

const bot = createSupportBot(config.supportBotToken, new Api(config.botToken));
setInterval(() => void remindUnanswered(bot).catch(() => {}), 15 * 60_000);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`Поддержка @${me.username} запущена`) });
