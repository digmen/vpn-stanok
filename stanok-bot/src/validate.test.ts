import { describe, expect, it } from '@jest/globals';
import { isNonEmptySecret, isValidBotToken, isValidIpv4 } from './validate.js';

describe('isValidIpv4', () => {
  it('принимает валидные IP', () => {
    expect(isValidIpv4('123.45.67.89')).toBe(true);
    expect(isValidIpv4('  10.0.0.1 ')).toBe(true);
    expect(isValidIpv4('255.255.255.255')).toBe(true);
  });

  it('отклоняет мусор', () => {
    expect(isValidIpv4('256.1.1.1')).toBe(false);
    expect(isValidIpv4('1.2.3')).toBe(false);
    expect(isValidIpv4('abc')).toBe(false);
    expect(isValidIpv4('')).toBe(false);
  });
});

describe('isValidBotToken', () => {
  it('принимает похожее на токен', () => {
    expect(isValidBotToken('123456789:AAH1234567890abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('отклоняет мусор', () => {
    expect(isValidBotToken('нет')).toBe(false);
    expect(isValidBotToken('123:short')).toBe(false);
    expect(isValidBotToken('')).toBe(false);
  });
});

describe('isNonEmptySecret', () => {
  it('минимум 3 непробельных символа', () => {
    expect(isNonEmptySecret('abc')).toBe(true);
    expect(isNonEmptySecret('  a ')).toBe(false);
    expect(isNonEmptySecret('')).toBe(false);
  });
});
