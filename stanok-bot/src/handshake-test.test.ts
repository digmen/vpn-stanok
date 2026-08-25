import { describe, expect, test } from '@jest/globals';
import { parseClientConfig } from './handshake-test.js';

const SAMPLE = `[Interface]
PrivateKey = cMyvucdZZOm3zKZwh3ICPQf8qAxcddCznEe5QRDv7kc=
Address = 10.66.66.4/32,fd42:42:42:0:0:0:0:4/128
DNS = 1.1.1.1,1.0.0.1
Jc = 7
Jmin = 50
Jmax = 1000
S1 = 105
S2 = 113
S3 = 112
S4 = 98
H1 = 332480729-432480728
H2 = 929261166-1029261165
H3 = 1410118797-1510118796
H4 = 1908639185-2008639184

[Peer]
PublicKey = Bla/OFCT4s5vxfH/IKXq6ab+NvHhT7ioUvzhfS8tgng=
PresharedKey = 6LFKa6pfU9RzaTs0Og1wPRsV9Vg4yDs5LNhJvHa6TDo=
Endpoint = 150.251.145.250:59234
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;

describe('parseClientConfig', () => {
  test('вытаскивает ключи, endpoint и все поля обфускации', () => {
    const p = parseClientConfig(SAMPLE);
    expect(p.privateKey).toBe('cMyvucdZZOm3zKZwh3ICPQf8qAxcddCznEe5QRDv7kc=');
    expect(p.serverPublicKey).toBe('Bla/OFCT4s5vxfH/IKXq6ab+NvHhT7ioUvzhfS8tgng=');
    expect(p.presharedKey).toBe('6LFKa6pfU9RzaTs0Og1wPRsV9Vg4yDs5LNhJvHa6TDo=');
    expect(p.endpoint).toBe('150.251.145.250:59234');
    expect(p.obfuscation).toEqual({
      Jc: '7',
      Jmin: '50',
      Jmax: '1000',
      S1: '105',
      S2: '113',
      S3: '112',
      S4: '98',
      H1: '332480729-432480728',
      H2: '929261166-1029261165',
      H3: '1410118797-1510118796',
      H4: '1908639185-2008639184',
    });
  });

  test('без обфускации (plain WireGuard) — поля просто пустые, не падает', () => {
    const plain = `[Interface]\nPrivateKey = AAAA\n\n[Peer]\nPublicKey = BBBB\nEndpoint = 1.2.3.4:51820`;
    const p = parseClientConfig(plain);
    expect(p.obfuscation).toEqual({});
    expect(p.endpoint).toBe('1.2.3.4:51820');
  });

  test('нет PrivateKey/Endpoint/PublicKey — кидает понятную ошибку', () => {
    expect(() => parseClientConfig('[Interface]\nAddress = 10.0.0.1/32')).toThrow(
      /PrivateKey.*Endpoint.*PublicKey/,
    );
  });
});
