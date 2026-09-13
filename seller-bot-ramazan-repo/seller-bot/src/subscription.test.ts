import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Та же схема, что в subscriptions.test.ts: env до динамического импорта,
// запись во временную папку — не трогаем живые ключи/телеметрию.
process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-sub-test-'));

const { addSubscriptionHours } = await import('./subscriptions.js');
const { PRIMARY_LOCATION_ID } = await import('./locations.js');
const S = await import('./subscription.js');

test('parseConnInfo: разбирает вывод read-only скрипта', () => {
  const info = S.parseConnInfo('{"domain":"node1.example.com","port":443,"wsPath":"/a1b2c3"}\n');
  assert.deepEqual(info, { domain: 'node1.example.com', port: 443, wsPath: '/a1b2c3' });
});

test('parseConnInfo: мусор/неполный JSON — null, не бросает', () => {
  assert.equal(S.parseConnInfo('нет jq в системе'), null);
  assert.equal(S.parseConnInfo('{"domain":"x"}'), null); // нет port/wsPath
  assert.equal(S.parseConnInfo(''), null);
});

test('buildLink: собирает ту же ссылку, что add-vless-ws-tls-peer.sh, для уже выданного uuid', () => {
  const loc = { id: PRIMARY_LOCATION_ID, title: 'Основной', kind: 'local' as const, protocol: 'vless_ws_tls' as const };
  const info = { domain: 'node19.fleurdelis-club.site', port: 443, wsPath: '/xk92mZ' };
  const link = S.buildLink('11111111-2222-3333-4444-555555555555', loc, info);
  assert.equal(
    link,
    'vless://11111111-2222-3333-4444-555555555555@node19.fleurdelis-club.site:443' +
      '?type=ws&security=tls&sni=node19.fleurdelis-club.site&host=node19.fleurdelis-club.site' +
      '&path=%2Fxk92mZ&encryption=none#%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%BE%D0%B9',
  );
});

test('subscriptionToken: pubkey первого пира; пусто — null', () => {
  assert.equal(S.subscriptionToken({ peers: [{ loc: 'l1', pubkey: 'AAA' }], expiresAt: 0 }), 'AAA');
  assert.equal(S.subscriptionToken({ peers: [], expiresAt: 0 }), null);
});

test('findSubByToken: находит подписку по pubkey любого из пиров, не только первого', () => {
  addSubscriptionHours([{ loc: PRIMARY_LOCATION_ID, pubkey: 'FIRST' }, { loc: 'l2', pubkey: 'SECOND' }], 24, {
    userId: 42,
    username: 'vasya',
  });
  const byFirst = S.findSubByToken('FIRST');
  const bySecond = S.findSubByToken('SECOND');
  assert.ok(byFirst);
  assert.equal(byFirst!.userId, 42);
  assert.ok(bySecond);
  assert.equal(bySecond!.username, 'vasya');
  assert.equal(S.findSubByToken('НЕТУТАКОГО'), null);
});

test('handleSubscriptionRequest: неизвестный токен -> 404, известный -> 200 с base64', async () => {
  addSubscriptionHours([{ loc: 'no-such-location', pubkey: 'GHOST' }], 24, { userId: 1 });
  const calls: { code?: number; body?: string }[] = [];
  const fakeRes = {
    writeHead(code: number) {
      calls.push({ code });
      return this;
    },
    end(body?: string) {
      calls[calls.length - 1].body = body;
    },
    headersSent: false,
  } as any;
  await S.handleSubscriptionRequest({} as any, fakeRes, 'НЕ_СУЩЕСТВУЕТ');
  assert.equal(calls[0].code, 404);

  await S.handleSubscriptionRequest({} as any, fakeRes, 'GHOST');
  // Локации 'no-such-location' нет в конфиге -> ссылок 0, но ответ всё равно 200
  // (подписка валидна, просто пока ни один сервер не читается) — путь без падения.
  assert.equal(calls[1].code, 200);
  assert.equal(Buffer.from(calls[1].body!, 'base64').toString('utf8'), '');
});

test('handleSubscriptionRequest: истёкшая подписка -> 410', async () => {
  addSubscriptionHours([{ loc: PRIMARY_LOCATION_ID, pubkey: 'EXPIRED' }], -1, { userId: 2 }); // отрицательные часы = уже истекло
  const calls: { code?: number }[] = [];
  const fakeRes = {
    writeHead(code: number) {
      calls.push({ code });
      return this;
    },
    end() {},
    headersSent: false,
  } as any;
  await S.handleSubscriptionRequest({} as any, fakeRes, 'EXPIRED');
  assert.equal(calls[0].code, 410);
});

test('fmtAgo: минуты/часы/дни', () => {
  const now = Date.now();
  assert.equal(S.fmtAgo(now - 5 * 60_000), '5 мин назад');
  assert.equal(S.fmtAgo(now - 3 * 3_600_000), '3 ч назад');
  assert.equal(S.fmtAgo(now - 3 * 24 * 3_600_000), '3 дн назад');
});

test('buildSubStats: по обращениям из handleSubscriptionRequest считает клиента и показывает его', async () => {
  addSubscriptionHours([{ loc: PRIMARY_LOCATION_ID, pubkey: 'STATTOKEN' }], 24, { userId: 5, username: 'stat_user' });
  const fakeRes = {
    writeHead() {
      return this;
    },
    end() {},
    headersSent: false,
  } as any;
  await S.handleSubscriptionRequest({} as any, fakeRes, 'STATTOKEN');
  const text = S.buildSubStats();
  assert.match(text, /Всего обращений: \d+/);
  assert.match(text, /@stat_user/);
});
