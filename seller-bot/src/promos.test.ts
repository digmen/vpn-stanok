import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-promo-'));

const { addPromo, checkPromo, discountedStars, markPromoUsed, removePromo, allPromos, isValidCode } =
  await import('./promos.js');

const ANN = 501;
const BOB = 502;

function reset(): void {
  for (const p of allPromos()) removePromo(p.code);
}

// 🔴 Каждое правило здесь — про деньги владельца. Нарушится молча — узнаем по выручке.

test('скидка считается от цены и не опускается ниже 1 звезды', () => {
  assert.equal(discountedStars(100, 20), 80);
  assert.equal(discountedStars(50, 50), 25);
  // Telegram не принимает счёт дешевле 1⭐ — даже при 90% от 1⭐ должно остаться 1
  assert.equal(discountedStars(1, 90), 1);
});

test('код регистронезависимый: человек введёт как угодно', () => {
  reset();
  addPromo('leto', 20);
  const r = checkPromo('LeTo', ANN);
  assert.equal(r.ok, true);
});

test('один человек — один раз по одному коду', () => {
  reset();
  addPromo('ONCE', 30);
  assert.equal(checkPromo('ONCE', ANN).ok, true);
  markPromoUsed('ONCE', ANN);
  const second = checkPromo('ONCE', ANN);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, 'used');
  // другому человеку тот же код всё ещё доступен
  assert.equal(checkPromo('ONCE', BOB).ok, true);
});

test('лимит использований исчерпывается', () => {
  reset();
  addPromo('LIMIT', 10, 1);
  markPromoUsed('LIMIT', ANN);
  const r = checkPromo('LIMIT', BOB);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'exhausted');
});

test('несуществующий код отвергается', () => {
  reset();
  const r = checkPromo('NOPE', ANN);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'unknown');
});

test('повторное списание одного кода одним человеком не накручивает счётчик', () => {
  reset();
  addPromo('DOUBLE', 15, 5);
  markPromoUsed('DOUBLE', ANN);
  markPromoUsed('DOUBLE', ANN);
  assert.equal(allPromos().find((p) => p.code === 'DOUBLE')!.usedBy.length, 1);
});

test('дубликат кода не создаётся', () => {
  reset();
  assert.equal(addPromo('UNIQ', 10), true);
  assert.equal(addPromo('uniq', 20), false, 'тот же код в другом регистре — тот же код');
});

test('проверка формата кода', () => {
  assert.equal(isValidCode('LETO2026'), true);
  assert.equal(isValidCode('ab'), false, 'слишком короткий');
  assert.equal(isValidCode('код'), false, 'кириллицу не принимаем — её тяжело диктовать');
  assert.equal(isValidCode('with space'), false);
});
