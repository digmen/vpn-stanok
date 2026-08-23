import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Та же схема, что в settings.test.ts: подставляем окружение ДО динамического
// импорта и уводим запись во временную папку, чтобы не тронуть живые подписки.
process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-test-'));

const { normalizeSub } = await import('./subscriptions.js');
const { PRIMARY_LOCATION_ID, isValidHost } = await import('./locations.js');

// 🔴 Самое опасное место бота: на живых узлах уже лежат подписки, за которые
// заплатили. Ошибка в чтении старого формата = у клиентов молча пропал доступ,
// а деньги остались у владельца. Поэтому каждое поколение формата — свой тест.

test('v1: только pubkey и срок — становится пиром на основной локации', () => {
  const s = normalizeSub({ pubkey: 'AAA', expiresAt: 111 });
  assert.ok(s);
  assert.equal(s.expiresAt, 111);
  assert.deepEqual(s.peers, [{ loc: PRIMARY_LOCATION_ID, pubkey: 'AAA' }]);
});

test('v2: данные покупателя переносятся целиком', () => {
  const s = normalizeSub({
    pubkey: 'BBB',
    expiresAt: 222,
    userId: 7,
    username: 'vasya',
    days: 30,
    stars: 50,
    boughtAt: 100,
  });
  assert.ok(s);
  assert.deepEqual(s.peers, [{ loc: PRIMARY_LOCATION_ID, pubkey: 'BBB' }]);
  assert.equal(s.userId, 7);
  assert.equal(s.username, 'vasya');
  assert.equal(s.days, 30);
  assert.equal(s.stars, 50);
  assert.equal(s.boughtAt, 100);
});

test('v3: несколько локаций читаются как есть', () => {
  const s = normalizeSub({
    peers: [
      { loc: 'local', pubkey: 'AAA' },
      { loc: 'l2', pubkey: 'BBB' },
    ],
    expiresAt: 333,
  });
  assert.ok(s);
  assert.equal(s.peers.length, 2);
  assert.equal(s.peers[1].loc, 'l2');
});

test('пир без локации считается основным, а не выбрасывается', () => {
  // Подстраховка: если запись частично записалась (сбой/ручная правка),
  // потерять оплаченный ключ хуже, чем отнести его к основному серверу.
  const s = normalizeSub({ peers: [{ pubkey: 'CCC' }], expiresAt: 444 });
  assert.ok(s);
  assert.deepEqual(s.peers, [{ loc: PRIMARY_LOCATION_ID, pubkey: 'CCC' }]);
});

test('мусор отбрасывается, но не роняет чтение всего файла', () => {
  assert.equal(normalizeSub({} as never), null);
  assert.equal(normalizeSub({ expiresAt: 1 }), null);                 // нет ни одного ключа
  assert.equal(normalizeSub({ pubkey: 'A' }), null);                  // нет срока
  assert.equal(normalizeSub({ pubkey: 'A', expiresAt: NaN }), null);  // битый срок
  assert.equal(normalizeSub({ peers: [], expiresAt: 5 }), null);      // пустой список пиров
  assert.equal(normalizeSub({ peers: [{ loc: 'l2', pubkey: '' }], expiresAt: 5 }), null);
});

test('проверка адреса сервера перед SSH', () => {
  assert.ok(isValidHost('203.0.113.10'));
  assert.ok(isValidHost('vpn.example.com'));
  assert.ok(!isValidHost(''));
  assert.ok(!isValidHost('999.1.1.1'));
  assert.ok(!isValidHost('не адрес'));
  assert.ok(!isValidHost('localhost'));   // без точки — почти наверняка опечатка
});
