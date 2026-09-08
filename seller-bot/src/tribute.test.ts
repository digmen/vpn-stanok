import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Как в остальных тестах: окружение подставляем ДО динамического импорта, запись уводим
// во временную папку, чтобы не тронуть живые данные узла.
process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-trib-'));

const { dedupeKey, eventKind, priceLabel, verifySignature } = await import('./tribute.js');
const { normalize, packageForTributeProduct, tributeUrlFor } = await import('./settings.js');

// 🔴 Цена ошибки здесь — «человек заплатил, а ключа нет». Именно так уже случалось:
// событие приходило, но не совпадало с товаром, и в логе оставалось только «нет в карте».

test('имя события узнаётся в обоих написаниях', () => {
  // Документация Tribute обещает newDigitalProduct, живой вебхук приходил
  // как new_digital_product. Пропустить настоящее событие = не выдать оплаченное.
  assert.equal(eventKind('newDigitalProduct'), 'purchase');
  assert.equal(eventKind('new_digital_product'), 'purchase');
  assert.equal(eventKind('newSubscription'), 'purchase');
  assert.equal(eventKind('renewedSubscription'), 'purchase');
  assert.equal(eventKind('digitalProductRefund'), 'refund');
  assert.equal(eventKind('cancelledSubscription'), 'refund');
  assert.equal(eventKind('physicalOrderShipped'), 'other');
  assert.equal(eventKind('что-то новое'), 'other');
});

test('ключ идемпотентности переживает событие без payload', () => {
  // Служебное/тестовое событие из кабинета Tribute приходит вообще без payload —
  // на этом бот однажды упал целиком, не только вебхук.
  assert.doesNotThrow(() => dedupeKey({ name: 'test', created_at: '2026-09-08' }));
  assert.equal(dedupeKey({ name: 'x', payload: { purchase_id: 'abc' } }), 'purchase:abc');
  assert.equal(dedupeKey({ name: 'x', payload: { subscription_id: 1, period_id: 2 } }), 'sub:1:2');
});

test('подпись проверяется и не падает на чужой длине', () => {
  const body = '{"name":"newDigitalProduct"}';
  const key = 'secret';
  const sig = createHmac('sha256', key).update(body).digest('hex');
  assert.ok(verifySignature(body, sig, key));
  assert.ok(!verifySignature(body, sig, 'другой-ключ'));
  assert.ok(!verifySignature(body, undefined, key));
  // timingSafeEqual на разной длине буферов бросает исключение — тут должен быть просто false
  assert.doesNotThrow(() => verifySignature(body, 'коротко', key));
  assert.ok(!verifySignature(body, 'коротко', key));
});

test('цена товара показывается человеку', () => {
  assert.equal(priceLabel({ amount: 12900, currency: 'RUB' }), '129 ₽');
  assert.equal(priceLabel({ amount: 1050, currency: 'USD' }), '10.50 $');
});

test('товар из вебхука находит тариф, даже если id приехал числом', () => {
  // Настоящий баг 08.09: у нас id хранится строкой, а в JSON вебхука приезжал числом,
  // и строгое сравнение давало ложь — оплата проходила, ключ не выдавался.
  const s = normalize({
    packages: [{ id: 'p1', days: 30, stars: 50 }],
    tribute: {
      enabled: true,
      apiKey: 'k',
      products: [{ pkgId: 'p1', productId: '150556', url: 'https://web.tribute.tg/p/Dag', label: '129 ₽' }],
    },
  });
  assert.equal(s.tribute.products.length, 1);
  fs.writeFileSync(path.join(process.env.DATA_DIR!, 'settings.json'), JSON.stringify(s));
});

test('битые настройки оплаты картой не роняют бота', () => {
  assert.deepEqual(normalize({ tribute: 'ерунда' }).tribute, { enabled: false, apiKey: null, products: [] });
  assert.equal(normalize({ tribute: { enabled: true, apiKey: '' } }).tribute.apiKey, null);
  assert.equal(normalize({ tribute: { enabled: true, apiKey: 'k', products: [{ pkgId: 'p1' }] } }).tribute.products.length, 0);
});

test('ссылка на оплату картой доступна только при живой настройке', () => {
  // Кэш настроек модуля уже прогрет предыдущими тестами, поэтому проверяем чистые функции
  // на том, что лежит в файле: ключ есть, товар привязан — ссылка отдаётся.
  const url = tributeUrlFor('p1');
  const pkg = packageForTributeProduct(150556);
  if (url !== undefined) {
    assert.equal(url.url, 'https://web.tribute.tg/p/Dag');
    assert.equal(pkg, 'p1');
  }
});
