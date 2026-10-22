// Подписывает объявление франшизы и пишет seller-bot/ads/current.json.
//   node scripts/sign-ad.mjs <id> <от ISO> <до ISO> <файл-с-текстом.txt> [путь-к-ключу]
// Ключ по умолчанию: ~/.secrets/ads-signing.key (приватный ed25519, есть только у автора франшизы).
// Боты на узлах принимают объявление только с верной подписью (src/ads.ts, verifyAd), поэтому
// доступ к репозиторию сам по себе не даёт права рассылать клиентам.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [id, from, until, textFile, keyPath = path.join(homedir(), '.secrets', 'ads-signing.key')] = process.argv.slice(2);
if (!id || !from || !until || !textFile) {
  console.error('Использование: node scripts/sign-ad.mjs <id> <от ISO> <до ISO> <файл с текстом> [ключ]');
  process.exit(1);
}
const text = readFileSync(textFile, 'utf8').trim();
if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('id: латиница, цифры, _ и -, до 40 знаков');
if (!text || text.length > 800) throw new Error('текст: от 1 до 800 знаков');
if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(until))) throw new Error('даты в формате ISO');

// Тот же порядок, что adPayload() в src/ads.ts.
const payload = [id, from, until, text].join('\n');
const sig = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(readFileSync(keyPath, 'utf8'))).toString('base64');

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ads/current.json');
writeFileSync(out, JSON.stringify({ id, text, from, until, sig }, null, 2) + '\n');
console.log('Записано', out, '— теперь закоммить и влей в main; боты подхватят в течение 3 часов.');
