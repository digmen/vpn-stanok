import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Нет переменной ${name}. Скопируй .env.example → .env и заполни.`);
  }
  return v;
}

function positiveInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} должно быть целым положительным числом, а не "${raw}".`);
  }
  return n;
}

export const config = {
  botToken: required('SELLER_BOT_TOKEN'),
  // id владельца бота (узла) — ему VPN бесплатно
  ownerId: Number(process.env.OWNER_ID ?? '0'),
  priceStars: positiveInt('PRICE_STARS', 1), // тестовая цена; поднять перед запуском
  days: positiveInt('VPN_DAYS', 30),
  stanokUrl: process.env.STANOK_URL ?? 'https://t.me/VPNForge_bot',
};
