import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEndpointHost, withVlessHost } from './parse.js';

// Общий фикс бага 25.08: Endpoint в клиентском конфиге должен браться из адреса
// локации в боте (владелец им управляет), а не из зашитого на сервере IP.
// withEndpointHost перезаписывает host в строке Endpoint, сохраняя порт.

test('меняет host, сохраняя порт', () => {
  assert.equal(
    withEndpointHost('Endpoint = 81.29.146.30:52066', '132.243.224.203'),
    'Endpoint = 132.243.224.203:52066',
  );
});

test('внутри полного конфига трогает только строку Endpoint', () => {
  const cfg = [
    '[Interface]',
    'PrivateKey = xxxx',
    'Address = 10.8.1.5/32',
    'DNS = 1.1.1.1',
    '',
    '[Peer]',
    'PublicKey = yyyy',
    'Endpoint = 81.29.146.30:52066',
    'AllowedIPs = 0.0.0.0/0',
  ].join('\n');
  const out = withEndpointHost(cfg, '132.243.224.203');
  assert.match(out, /^Endpoint = 132\.243\.224\.203:52066$/m);
  assert.ok(out.includes('Address = 10.8.1.5/32'));
  assert.ok(out.includes('PublicKey = yyyy'));
  // порт и остальное не тронуты
  assert.ok(!out.includes('81.29.146.30'));
});

test('сохраняет нестандартный порт', () => {
  assert.equal(
    withEndpointHost('Endpoint = 10.0.0.1:443', '203.0.113.9'),
    'Endpoint = 203.0.113.9:443',
  );
});

test('меняет и hostname, не только IP', () => {
  assert.equal(
    withEndpointHost('Endpoint = old.example.com:51820', '198.51.100.7'),
    'Endpoint = 198.51.100.7:51820',
  );
});

test('нет строки Endpoint — возвращает как есть, не ломает', () => {
  const cfg = '[Interface]\nPrivateKey = zzz\n';
  assert.equal(withEndpointHost(cfg, '1.2.3.4'), cfg);
});

test('лишние пробелы вокруг = допустимы', () => {
  assert.equal(
    withEndpointHost('Endpoint=81.29.146.30:52066', '9.9.9.9'),
    'Endpoint=9.9.9.9:52066',
  );
});

// withVlessHost — тот же фикс бага 25.08, для VLESS+Reality-ссылок вместо
// WireGuard-конфига (см. комментарий в parse.ts).

test('vless: меняет host в @host:port, оставляя остальное как есть', () => {
  const link =
    'vless://ab3ff2ad-905b-4828-92c8-c7d79a12497c@0.0.0.0:443?type=tcp&security=reality&' +
    'pbk=UvHrEm4h-aToTbso3JZUa8sGdIqIk0FLpE4eY_8XJQQ&fp=chrome&sni=addons.mozilla.org&' +
    'sid=3b561373a6ee57fb&flow=xtls-rprx-vision#0.0.0.0';
  const out = withVlessHost(link, '194.87.126.220');
  // Меняется именно @host:port, а не что попало по подстроке — старый адрес
  // ниже в строке (в подписи label после #) намеренно НЕ трогаем, это только
  // косметическое имя профиля в приложении клиента, не адрес подключения.
  assert.match(out, /^vless:\/\/ab3ff2ad-905b-4828-92c8-c7d79a12497c@194\.87\.126\.220:443\?/);
  // sni — цель маскировки, не адрес сервера, не должен трогаться
  assert.ok(out.includes('sni=addons.mozilla.org'));
});

test('vless: сохраняет UUID и порт нетронутыми', () => {
  const link = 'vless://uuid-123@1.2.3.4:8443?type=tcp&security=reality#label';
  assert.equal(
    withVlessHost(link, '9.9.9.9'),
    'vless://uuid-123@9.9.9.9:8443?type=tcp&security=reality#label',
  );
});

test('vless: не путает host в @ с host= query-параметром дальше в строке', () => {
  const link = 'vless://uuid@1.2.3.4:443?host=example.com&sni=example.com#label';
  const out = withVlessHost(link, '5.6.7.8');
  assert.ok(out.startsWith('vless://uuid@5.6.7.8:443?'));
  assert.ok(out.includes('host=example.com')); // query-параметр не тронут
});
