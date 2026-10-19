import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// traffic.ts и settings.ts читают config (токен бота, папка данных) — подставляем ДО динамического импорта.
process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-test-'));

const { applyDeltas, decideAction, emptyState, GB, monthKey, parseTrafficLines, subUsage, userinfoHeader } = await import('./traffic.js');
const { isValidLimitGb, normalize } = await import('./settings.js');

const OCT = Date.parse('2026-10-19T12:00:00Z');
const NOV = Date.parse('2026-11-01T00:05:00Z');
const sub = (...keys: string[]) => ({ peers: keys.map((k) => ({ loc: 'local', pubkey: k })), expiresAt: OCT + 1e9 });

test('parseTrafficLines: берёт строки JSON, пропускает мусор', () => {
  const out = parseTrafficLines('шум\n{"uuid":"a","up":5,"down":7}\n{"uuid":"b","up":"x","down":1}\n{не json\n');
  assert.deepEqual(out, [{ uuid: 'a', up: 5, down: 7 }]);
});

test('applyDeltas: приращения копятся, новый месяц обнуляет счёт', () => {
  let st = emptyState(OCT);
  st = applyDeltas(st, [{ uuid: 'a', up: 1, down: 2 }], OCT);
  st = applyDeltas(st, [{ uuid: 'a', up: 3, down: 4 }], OCT);
  assert.deepEqual(st.used.a, { up: 4, down: 6 });
  const next = applyDeltas({ ...st, blocked: ['a'] }, [{ uuid: 'a', up: 1, down: 1 }], NOV);
  assert.equal(next.month, '2026-11');
  assert.deepEqual(next.used.a, { up: 1, down: 1 });
  assert.deepEqual(next.blocked, ['a']); // блокировку снимает сверка, а не сам сброс
});

test('subUsage: суммирует ключи подписки по всем локациям', () => {
  const st = applyDeltas(emptyState(OCT), [
    { uuid: 'a', up: 1, down: 2 },
    { uuid: 'b', up: 10, down: 20 },
    { uuid: 'zzz', up: 99, down: 99 },
  ], OCT);
  assert.deepEqual(subUsage(st, sub('a', 'b')), { up: 11, down: 22 });
});

test('decideAction: блок при превышении, возврат при новом месяце/повышении лимита/выключении', () => {
  const over = { up: 30 * GB, down: 21 * GB };
  assert.equal(decideAction(50, over, false), 'block');
  assert.equal(decideAction(50, over, true), 'none');
  assert.equal(decideAction(100, over, true), 'unblock'); // подняли лимит
  assert.equal(decideAction(0, over, true), 'unblock'); // выключили
  assert.equal(decideAction(50, { up: 0, down: 0 }, true), 'unblock'); // новый месяц
  assert.equal(decideAction(50, { up: 1, down: 1 }, false), 'none');
  assert.equal(decideAction(0, over, false), 'none'); // без лимита не блокируем никогда
});

test('userinfoHeader: total только при лимите, expire в секундах', () => {
  assert.equal(userinfoHeader({ up: 1, down: 2 }, 50, 1800000000000), `upload=1; download=2; total=${50 * GB}; expire=1800000000`);
  assert.equal(userinfoHeader({ up: 1, down: 2 }, 0, 1800000000000), 'upload=1; download=2; expire=1800000000');
});

test('monthKey: по UTC', () => {
  assert.equal(monthKey(Date.parse('2026-10-31T23:59:59Z')), '2026-10');
  assert.equal(monthKey(Date.parse('2026-11-01T00:00:00Z')), '2026-11');
});

test('настройки: лимит читается, мусор и старые файлы дают 0', () => {
  assert.equal(normalize({ traffic: { limitGb: 50 } }).traffic.limitGb, 50);
  assert.equal(normalize({}).traffic.limitGb, 0);
  assert.equal(normalize({ traffic: { limitGb: -5 } }).traffic.limitGb, 0);
  assert.equal(isValidLimitGb(1.5), false);
});
