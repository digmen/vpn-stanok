import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-ads-test-'));

const A = await import('./ads.js');
type Ad = import('./ads.js').Ad;

// Свои ключи для теста: настоящий приватный ключ в репозитории не нужен и не лежит.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
function signed(over: Partial<Ad> = {}): Ad {
  const ad = { id: 'camp1', text: 'Хочешь такой же бот? {LINK}', from: '2026-10-24T00:00:00Z', until: '2026-10-31T00:00:00Z', ...over };
  const sig = sign(null, Buffer.from(A.adPayload(ad), 'utf8'), privateKey).toString('base64');
  return { ...ad, sig };
}

test('verifyAd: верная подпись проходит, правка текста, срока или id ломает её', () => {
  const ad = signed();
  assert.equal(A.verifyAd(ad, pubPem), true);
  assert.equal(A.verifyAd({ ...ad, text: ad.text + ' !' }, pubPem), false);
  assert.equal(A.verifyAd({ ...ad, until: '2027-01-01T00:00:00Z' }, pubPem), false);
  assert.equal(A.verifyAd({ ...ad, id: 'camp2' }, pubPem), false);
});

test('verifyAd: чужой ключ и мусор вместо подписи не проходят и не бросают', () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(A.verifyAd(signed(), other), false);
  assert.equal(A.verifyAd({ ...signed(), sig: '!!!' }, pubPem), false);
  // вшитый в бота публичный ключ не принимает подпись тестового
  assert.equal(A.verifyAd(signed()), false);
});

test('parseAd: пустая кампания, кривые поля и слишком длинный текст — null', () => {
  assert.equal(A.parseAd(null), null);
  assert.equal(A.parseAd({ id: '', text: '', from: 'x', until: 'y', sig: '' }), null);
  assert.equal(A.parseAd({ ...signed(), id: 'плохой id' }), null);
  assert.equal(A.parseAd({ ...signed(), text: 'я'.repeat(801) }), null);
  assert.equal(A.parseAd({ ...signed(), from: 'не дата' }), null);
  assert.ok(A.parseAd(signed()));
});

test('isAdActive: только внутри срока', () => {
  const ad = signed();
  assert.equal(A.isAdActive(ad, Date.parse('2026-10-23T23:59:59Z')), false);
  assert.equal(A.isAdActive(ad, Date.parse('2026-10-25T12:00:00Z')), true);
  assert.equal(A.isAdActive(ad, Date.parse('2026-11-01T00:00:00Z')), false);
});

test('inSendWindow: только днём (07–18 UTC)', () => {
  assert.equal(A.inSendWindow(Date.parse('2026-10-25T06:59:00Z')), false);
  assert.equal(A.inSendWindow(Date.parse('2026-10-25T07:00:00Z')), true);
  assert.equal(A.inSendWindow(Date.parse('2026-10-25T17:59:00Z')), true);
  assert.equal(A.inSendWindow(Date.parse('2026-10-25T18:00:00Z')), false);
});

const NOW = Date.parse('2026-10-25T10:00:00Z');
const DAY = 86_400_000;

test('planBatch: владелец, отписавшиеся, уже получившие и получавшие недавно — не в списке', () => {
  const state = {
    ...A.emptyState(),
    optout: [3],
    sent: { camp1: [4] },
    last: { '5': NOW - 3 * DAY, '6': NOW - 15 * DAY },
  };
  const got = A.planBatch({ ad: signed(), clients: [1, 2, 3, 4, 5, 6], ownerId: 1, state, now: NOW });
  assert.deepEqual(got, [2, 6]);
});

test('planBatch: за один проход не больше BATCH человек', () => {
  const clients = Array.from({ length: 1000 }, (_, i) => 1000 + i);
  const got = A.planBatch({ ad: signed(), clients, ownerId: 1, state: A.emptyState(), now: NOW });
  assert.equal(got.length, A.AD_LIMITS.BATCH);
});

test('adMessage: пометка «Реклама», ссылка подставлена', () => {
  const m = A.adMessage(signed(), 'https://t.me/VPNForge_bot?start=src_1');
  assert.match(m, /^📢 Реклама · VPNForge/);
  assert.match(m, /https:\/\/t\.me\/VPNForge_bot\?start=src_1/);
  assert.doesNotMatch(m, /\{LINK\}/);
});

test('согласие: по умолчанию выключено; включает и выключает владелец; отписка клиента запоминается', () => {
  assert.equal(A.adsEnabled(), false);
  assert.equal(A.readAdsState().asked, false);
  A.setConsent(true);
  assert.equal(A.adsEnabled(), true);
  assert.equal(A.readAdsState().asked, true);
  A.setConsent(false);
  assert.equal(A.adsEnabled(), false);
  A.optOut(77);
  A.optOut(77);
  assert.deepEqual(A.readAdsState().optout, [77]);
});

test('вопрос владельцу: честно называет, что выключено, и условия показа', () => {
  assert.match(A.ADS_CONSENT_QUESTION, /сейчас выключено/);
  assert.match(A.ADS_CONSENT_QUESTION, /Реклама · VPNForge/);
  assert.match(A.ADS_CONSENT_QUESTION, /не чаще раза в 14 дней/);
});
