import { randomBytes } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { makeCrypto } from './crypto-core.js';

const key = randomBytes(32).toString('hex');

describe('makeCrypto', () => {
  it('round-trip: decrypt(encrypt(x)) === x', () => {
    const c = makeCrypto(key);
    const secret = 'root-pass-!@#$-пароль';
    expect(c.decrypt(c.encrypt(secret))).toBe(secret);
  });

  it('один plaintext → разные ciphertext (случайный iv)', () => {
    const c = makeCrypto(key);
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });

  it('кидает на неверной длине ключа', () => {
    expect(() => makeCrypto('00')).toThrow();
  });

  it('чужой ключ не расшифрует (аутентификация GCM)', () => {
    const a = makeCrypto(key);
    const b = makeCrypto(randomBytes(32).toString('hex'));
    expect(() => b.decrypt(a.encrypt('secret'))).toThrow();
  });
});
