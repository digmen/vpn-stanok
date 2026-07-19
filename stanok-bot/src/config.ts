import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Нет переменной ${name}. Скопируй .env.example → .env и заполни.`);
  }
  return v;
}

// Ключ шифрования кредов. Если не задан в .env — генерим сами и сохраняем в .enckey.
// Так пользователю не нужно ничего придумывать, а пароли всё равно шифруются.
function loadEncryptionKey(): string {
  const fromEnv = process.env.ENCRYPTION_KEY?.trim();
  if (fromEnv) return fromEnv;

  const keyFile = '.enckey';
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();

  const key = randomBytes(32).toString('hex');
  writeFileSync(keyFile, key, { mode: 0o600 });
  console.warn('⚠️  ENCRYPTION_KEY не задан — сгенерирован и сохранён в .enckey (в .gitignore, не коммить).');
  return key;
}

export const config = {
  botToken: required('BOT_TOKEN'),
  encryptionKey: loadEncryptionKey(),
  referralLink: process.env.REFERRAL_LINK ?? 'https://rdp-onedash.ru/r/2b3c405',
  // Ссылка на самого станка — прокидывается в бота-продавца для кнопки «Заработай так же»
  stanokUrl: process.env.STANOK_URL ?? 'https://t.me/VPNForge_bot',
  // Цена VPN у ботов-продавцов (тестово 1⭐; поднять перед запуском)
  sellerPriceStars: Number(process.env.SELLER_PRICE_STARS ?? '1'),
  dbPath: process.env.DB_PATH ?? 'stanok.db',
  adminIds: (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  // file_id видео-инструкций (пусто → бот покажет текстовые подсказки)
  videos: {
    buy: process.env.INSTR_BUY_VIDEO ?? '',
    ip: process.env.INSTR_IP_VIDEO ?? '',
    password: process.env.INSTR_PASSWORD_VIDEO ?? '',
    token: process.env.INSTR_TOKEN_VIDEO ?? '',
  },
};
