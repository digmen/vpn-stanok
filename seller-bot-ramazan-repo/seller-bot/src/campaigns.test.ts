import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-campaigns-test-'));

const { isCampaignTag, recordCampaignTouch, campaignReport, allCampaignTags } = await import('./campaigns.js');
const { markTrialUsed } = await import('./trials.js');
const { recordEvent } = await import('./stats.js');

test('isCampaignTag: отличает метку от числового реферального кода и от мусора', () => {
  assert.equal(isCampaignTag('luna-trial'), true);
  assert.equal(isCampaignTag('luna_trial_2'), true);
  assert.equal(isCampaignTag('r123456789'), false); // это referrals.ts::parseCode, не метка
  assert.equal(isCampaignTag(''), false);
  assert.equal(isCampaignTag(undefined), false);
  assert.equal(isCampaignTag('привет'), false); // не латиница/цифры/-/_ — за пределами формата start
});

test('recordCampaignTouch: считает первый вход, повторные не плодят дубликаты', () => {
  recordCampaignTouch('luna-trial', 501);
  recordCampaignTouch('luna-trial', 501); // тот же человек ещё раз /start по той же ссылке
  recordCampaignTouch('luna-trial', 502);
  const r = campaignReport('luna-trial');
  assert.equal(r.starts, 2);
});

test('campaignReport: считает, кто из перешедших взял пробник и кто купил', () => {
  recordCampaignTouch('promo-x', 601);
  recordCampaignTouch('promo-x', 602);
  recordCampaignTouch('promo-x', 603);
  markTrialUsed(601);
  recordEvent({ type: 'paid', stars: 100, userId: 602, days: 30 });

  const r = campaignReport('promo-x');
  assert.equal(r.starts, 3);
  assert.equal(r.trials, 1);
  assert.equal(r.purchases, 1);
});

test('campaignReport: метка без переходов — нули, не бросает', () => {
  const r = campaignReport('нет-такой-метки');
  assert.deepEqual(r, { tag: 'нет-такой-метки', starts: 0, trials: 0, purchases: 0 });
});

test('allCampaignTags: перечисляет только реально встреченные метки', () => {
  const tags = allCampaignTags();
  assert.ok(tags.includes('luna-trial'));
  assert.ok(tags.includes('promo-x'));
  assert.ok(!tags.includes('нет-такой-метки'));
});
