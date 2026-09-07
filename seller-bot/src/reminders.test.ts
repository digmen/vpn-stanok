import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Та же схема, что в subscriptions.test.ts: окружение подставляем ДО динамического
// импорта и уводим запись во временную папку, чтобы не тронуть живые данные.
process.env.SELLER_BOT_TOKEN ??= '1:test';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-rem-'));
process.env.DATA_DIR ??= DIR;

const { pendingReminders, markReminded } = await import('./reminders.js');

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function writeSubs(subs: unknown[]): void {
  fs.writeFileSync(path.join(process.env.DATA_DIR!, 'subs.json'), JSON.stringify(subs));
}
function resetSent(): void {
  fs.rmSync(path.join(process.env.DATA_DIR!, 'reminders.json'), { force: true });
}

// 🔴 Цена ошибки здесь несимметрична в обе стороны: не напомнили — владелец потерял
// продление; напомнили лишний раз — человек получает одно и то же каждый час и уходит.
// Поэтому границы окна и «одно напоминание на один срок» проверяем явно.

test('попадает тот, у кого срок в пределах окна', () => {
  resetSent();
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW + DAY, userId: 111 }]);
  const got = pendingReminders(2, NOW);
  assert.equal(got.length, 1);
  assert.equal(got[0].userId, 111);
  assert.equal(got[0].daysLeft, 1);
});

test('не попадает тот, до чьего срока ещё далеко', () => {
  resetSent();
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW + 10 * DAY, userId: 111 }]);
  assert.equal(pendingReminders(2, NOW).length, 0);
});

test('не попадает уже истёкшая подписка — ей напоминать поздно', () => {
  resetSent();
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW - DAY, userId: 111 }]);
  assert.equal(pendingReminders(2, NOW).length, 0);
});

test('без userId пропускаем: в записях первого поколения покупателя нет', () => {
  resetSent();
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW + DAY }]);
  assert.equal(pendingReminders(2, NOW).length, 0);
});

test('одно напоминание на один срок — повторно не шлём', () => {
  resetSent();
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW + DAY, userId: 111 }]);
  const first = pendingReminders(2, NOW);
  assert.equal(first.length, 1);
  markReminded(first[0].key, NOW);
  assert.equal(pendingReminders(2, NOW).length, 0, 'второй раз тот же срок попасть не должен');
});

test('продлил подписку — новый срок, напоминание придёт снова', () => {
  resetSent();
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW + DAY, userId: 111 }]);
  markReminded(pendingReminders(2, NOW)[0].key, NOW);
  // тот же человек, но срок уже другой — это новая подписка, а не та же самая
  writeSubs([{ peers: [{ loc: 'local', pubkey: 'k1' }], expiresAt: NOW + 31 * DAY, userId: 111 }]);
  const later = NOW + 30 * DAY;
  assert.equal(pendingReminders(2, later).length, 1);
});
