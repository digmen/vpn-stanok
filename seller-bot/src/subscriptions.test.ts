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
const { PRIMARY_LOCATION_ID, isValidHost, parseHostPort } = await import('./locations.js');
const { promoEnabled } = await import('./branding.js');

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

// 23.08: у первого же клиента SSH оказался не на 22 — бот молча упирался
// в таймаут. Разбор адреса с портом теперь часть обязательного пути.
test('адрес с портом разбирается, 22 не хранится', () => {
  assert.deepEqual(parseHostPort('203.0.113.10'), { host: '203.0.113.10' });
  assert.deepEqual(parseHostPort('203.0.113.10:2222'), { host: '203.0.113.10', port: 2222 });
  assert.deepEqual(parseHostPort(' vpn.example.com:2222 '), { host: 'vpn.example.com', port: 2222 });
  // Стандартный порт не сохраняем: запись должна выглядеть как у всех остальных
  assert.deepEqual(parseHostPort('203.0.113.10:22'), { host: '203.0.113.10' });
});

// Промо-кнопка = канал роста франшизы, снимается платно и поштучно.
// Флаг лежит в папке данных, а не в .env: .env узла перезаписывается при
// каждом передеплое со станка, и оплаченное снятие молча откатилось бы.
test('промо-кнопка скрывается файлом white-label в папке данных', () => {
  const flag = path.join(process.env.DATA_DIR!, 'white-label');
  fs.rmSync(flag, { force: true });
  assert.equal(promoEnabled(), true);
  fs.writeFileSync(flag, '');
  assert.equal(promoEnabled(), false);
  fs.rmSync(flag, { force: true });
  assert.equal(promoEnabled(), true);
});

test('битый адрес с портом отбрасывается', () => {
  assert.equal(parseHostPort('203.0.113.10:0'), null);
  assert.equal(parseHostPort('203.0.113.10:70000'), null);
  assert.equal(parseHostPort('999.1.1.1:22'), null);
  assert.equal(parseHostPort(':22'), null);
  assert.equal(parseHostPort('не адрес'), null);
});
