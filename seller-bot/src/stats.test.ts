import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-stats-test-'));

const { recordEvent, hasPurchased, allTimeByTerm, buildStats } = await import('./stats.js');

test('hasPurchased: true после хотя бы одной оплаты, false для незнакомого id', () => {
  recordEvent({ type: 'paid', stars: 50, userId: 111, days: 30 });
  assert.equal(hasPurchased(111), true);
  assert.equal(hasPurchased(222), false);
});

test('allTimeByTerm: не чистится с истечением клиента — считает лог, а не действующие подписки', () => {
  // Файл лога общий на весь модуль (предыдущий test уже что-то в него дописал) —
  // сравниваем ПРИРОСТ от своих же записей, а не абсолютные числа.
  const before = new Map(allTimeByTerm().map((t) => [t.term, t]));
  const was = (term: string) => before.get(term) ?? { count: 0, stars: 0 };

  recordEvent({ type: 'paid', stars: 100, userId: 301, days: 30 });
  recordEvent({ type: 'paid', stars: 100, userId: 302, days: 30 });
  recordEvent({ type: 'paid', stars: 30, userId: 303, days: 7 });
  recordEvent({ type: 'paid', stars: 0, userId: 304, hours: 6 });
  recordEvent({ type: 'free', userId: 305 }); // бесплатная выдача — не в срез "продано"

  const byTerm = allTimeByTerm();
  const t30 = byTerm.find((t) => t.term === '30 дн.')!;
  const t7 = byTerm.find((t) => t.term === '7 дн.')!;
  const trial = byTerm.find((t) => t.term === '6 ч.')!;
  assert.equal(t30.count - was('30 дн.').count, 2);
  assert.equal(t30.stars - was('30 дн.').stars, 200);
  assert.equal(t7.count - was('7 дн.').count, 1);
  assert.equal(trial.count - was('6 ч.').count, 1);
  assert.ok(byTerm.indexOf(t30) < byTerm.indexOf(t7));
  assert.ok(byTerm.indexOf(t7) < byTerm.indexOf(trial));
});

test('allTimeByTerm: старые записи без срока не теряются молча', () => {
  recordEvent({ type: 'paid', stars: 40, userId: 999 }); // нет days/hours — как до 13.09
  const byTerm = allTimeByTerm();
  const unknown = byTerm.find((t) => t.term.startsWith('без срока'));
  assert.ok(unknown);
  assert.ok(unknown!.count >= 1);
});

test('buildStats: не падает и содержит разбивку по периодам и по срокам', async () => {
  const text = await buildStats();
  assert.match(text, /За месяц:/);
  assert.match(text, /За день:/);
  assert.match(text, /Продано по срокам/);
});
