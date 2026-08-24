import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEndpointHost } from './parse.js';

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
