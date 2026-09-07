import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Уводим состояние во временную папку, чтобы тест не тронул живые начисления
// на сервере — тот же приём, что в subscriptions.test.ts.
const dir = mkdtempSync(path.join(tmpdir(), 'refs-'));
process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR = dir;

// 🔴 Условие задаём явно, а не полагаемся на умолчание продукта: во франшизе
// реферальная программа по умолчанию ВЫКЛЮЧЕНА (она раздаёт время за счёт владельца,
// включать за него нельзя), и на умолчании эти тесты молча проверяли бы «ничего не
// начислено». Тест здесь про арифметику начислений, поэтому включаем её сами.
writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ referral: { enabled: true, percent: 30 } }));

const {
  bindReferral,
  parseCode,
  codeFor,
  registerPurchase,
  refundReferral,
  bankDays,
  takeBanked,
  statsFor,
  REFERRAL_MAX_DAYS,
} = await import('./referrals.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const ALICE = 1001;
const BOB = 1002;
const CAROL = 1003;

test('код ссылки разбирается обратно, мусор отбрасывается', () => {
  assert.equal(parseCode(codeFor(ALICE)), ALICE);
  assert.equal(parseCode('rABC'), null);
  assert.equal(parseCode('r0'), null);
  assert.equal(parseCode(undefined), null);
  assert.equal(parseCode('r-5'), null);
});

test('нельзя пригласить сам себя', () => {
  assert.equal(bindReferral(ALICE, ALICE), false);
});

test('владелец по чужой ссылке не привязывается', () => {
  assert.equal(bindReferral(9999, ALICE, { isOwner: true }), false);
});

test('первая ссылка навсегда: вторая не перебивает', () => {
  assert.equal(bindReferral(BOB, ALICE), true);
  assert.equal(bindReferral(BOB, CAROL), false);
});

test('переход по ссылке без покупки не начисляет ничего', () => {
  assert.equal(statsFor(ALICE).daysEarned, 0);
});

test('первая покупка приглашённого даёт 30% срока', () => {
  const award = registerPurchase(BOB, 30, 'charge-1');
  assert.deepEqual(award, { inviter: ALICE, days: 9 });
});

test('тот же платёж повторно не начисляет (идемпотентность)', () => {
  assert.equal(registerPurchase(BOB, 30, 'charge-1'), null);
  assert.equal(statsFor(ALICE).daysEarned, 9);
});

test('продление приглашённого бонуса больше не даёт', () => {
  assert.equal(registerPurchase(BOB, 30, 'charge-2'), null);
  assert.equal(statsFor(ALICE).daysEarned, 9);
});

test('привязка невозможна после того, как человек уже покупал', () => {
  // BOB уже покупал выше — сменить пригласившего задним числом нельзя.
  assert.equal(bindReferral(BOB, CAROL), false);
});

test('покупка без пригласившего никому ничего не даёт', () => {
  assert.equal(registerPurchase(7777, 30, 'charge-solo'), null);
});

test('возврат звёзд снимает начисленное', () => {
  const back = refundReferral('charge-1');
  assert.deepEqual(back, { inviter: ALICE, days: 9 });
  assert.equal(statsFor(ALICE).daysEarned, 0);
  // повторный возврат того же платежа — уже ничего
  assert.equal(refundReferral('charge-1'), null);
});

test('копилка отдаётся один раз и обнуляется', () => {
  bankDays(CAROL, 12);
  assert.equal(statsFor(CAROL).banked, 12);
  assert.equal(takeBanked(CAROL), 12);
  assert.equal(takeBanked(CAROL), 0);
});

test('потолок ограничивает бесконечное накручивание', () => {
  const inviter = 5000;
  let user = 6000;
  let total = 0;
  // Покупки огромного срока: без потолка одна такая дала бы годы.
  for (let i = 0; i < 12; i++) {
    user += 1;
    bindReferral(user, inviter);
    const a = registerPurchase(user, 365, 'ch-' + i);
    if (a) total += a.days;
  }
  assert.equal(total, REFERRAL_MAX_DAYS);
  assert.equal(statsFor(inviter).daysEarned, REFERRAL_MAX_DAYS);
});
