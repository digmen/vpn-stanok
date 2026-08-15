import { describe, expect, it } from '@jest/globals';
import { checkIp, ipProblemMessage, isNonEmptySecret, isValidBotToken, isValidIpv4 } from './validate.js';

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

describe('checkIp', () => {
  it('пропускает нормальные публичные адреса серверов', () => {
    expect(checkIp('81.29.146.68')).toBeNull(); // живой узел #18
    expect(checkIp(' 78.17.115.227 ')).toBeNull();
    expect(checkIp('104.143.218.5')).toBeNull(); // адрес маршрутизируется, дальше решает preflight
  });

  it('ловит адреса из примеров и документации', () => {
    expect(checkIp('123.45.67.88')).toBe('example'); // реальный случай: переписан из подсказки бота
    expect(checkIp('123.45.67.89')).toBe('example');
    expect(checkIp('192.0.2.15')).toBe('example');
    expect(checkIp('203.0.113.7')).toBe('example');
  });

  it('ловит серверы за NAT и внутренние адреса', () => {
    expect(checkIp('192.168.1.10')).toBe('private');
    expect(checkIp('10.66.66.2')).toBe('private');
    expect(checkIp('172.16.0.5')).toBe('private');
    expect(checkIp('172.32.0.5')).toBeNull(); // за границей 172.16/12 — публичный
    expect(checkIp('100.64.0.1')).toBe('private'); // CGNAT
    expect(checkIp('100.63.255.255')).toBeNull();
    expect(checkIp('127.0.0.1')).toBe('private');
  });

  it('ловит зарезервированное и мусор', () => {
    expect(checkIp('0.0.0.0')).toBe('reserved');
    expect(checkIp('224.0.0.1')).toBe('reserved');
    expect(checkIp('255.255.255.255')).toBe('reserved');
    expect(checkIp('1.95.163.86')).toBeNull(); // опечатка узла #20 — синтаксически годен, отсеет preflight
    expect(checkIp('не знаю')).toBe('not_ip');
  });

  it('на каждую причину есть текст для человека', () => {
    for (const p of ['not_ip', 'example', 'private', 'reserved'] as const) {
      expect(ipProblemMessage(p).length).toBeGreaterThan(20);
    }
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
