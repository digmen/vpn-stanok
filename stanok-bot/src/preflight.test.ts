import { describe, expect, it } from '@jest/globals';
import net from 'node:net';
import { checkSshPort, preflightMessage } from './preflight.js';

describe('preflightMessage', () => {
  it('на закрытый порт объясняет про выделенный IP, а не про таймаут', () => {
    const m = preflightMessage('104.143.218.5', 'timeout');
    expect(m).toContain('ВЫДЕЛЕННЫЙ IP');
    expect(m).toContain('104.143.218.5');
    expect(m.toLowerCase()).not.toContain('timeout');
  });

  it('различает «сервер ещё грузится» и «адреса нет»', () => {
    expect(preflightMessage('1.2.3.4', 'refused')).toContain('10 минут');
    expect(preflightMessage('1.2.3.4', 'unreachable')).toContain('опечатк');
  });
});

describe('checkSshPort', () => {
  it('видит открытый порт', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(await checkSshPort('127.0.0.1', 2000, port)).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it('на закрытый порт возвращает причину, а не бросает исключение', async () => {
    const res = await checkSshPort('127.0.0.1', 1000, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['refused', 'timeout', 'unreachable']).toContain(res.reason);
  });
});
