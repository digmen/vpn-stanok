import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-promo-test-'));

const P = await import('./promo-nudge.js');

test('promoLink: метка источника — id владельца бота; без id ссылка без метки', () => {
  assert.equal(P.promoLink('https://t.me/VPNForge_bot', 1145935758), 'https://t.me/VPNForge_bot?start=src_1145935758');
  assert.equal(P.promoLink('https://t.me/VPNForge_bot', 0), 'https://t.me/VPNForge_bot');
});

test('promoLink: параметр start укладывается в правила Telegram (до 64 знаков, латиница, цифры, _ и -)', () => {
  const link = P.promoLink('https://t.me/VPNForge_bot', 8999999999999);
  const param = link.split('start=')[1];
  assert.ok(param.length <= 64);
  assert.match(param, /^[A-Za-z0-9_-]+$/);
});

test('promoNudgeText: честно говорит, что это реклама франшизы, и что приходит один раз', () => {
  const t = P.promoNudgeText('https://t.me/VPNForge_bot?start=src_1');
  assert.match(t, /https:\/\/t\.me\/VPNForge_bot\?start=src_1/);
  assert.match(t, /VPNForge/);
  assert.match(t, /один раз/);
});

test('seen: человек помечается один раз, другой — нет', () => {
  assert.equal(P.hasSeenPromo(555), false);
  P.markPromoSeen(555);
  P.markPromoSeen(555);
  assert.equal(P.hasSeenPromo(555), true);
  assert.equal(P.hasSeenPromo(556), false);
});
