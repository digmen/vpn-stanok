import { describe, expect, it } from '@jest/globals';
import { getMeConfig, parseGetMe, parseTgReach, telegramBlockedMessage, TG_REACH_COMMAND } from './tg-reach.js';

describe('parseTgReach', () => {
  it('любой HTTP-ответ от Telegram = достаёт', () => {
    expect(parseTgReach('TG_HTTP=302\n')).toBe('ok');
    expect(parseTgReach('TG_HTTP=404')).toBe('ok');
    expect(parseTgReach('TG_HTTP=200')).toBe('ok');
  });

  it('000 (соединения нет) = заблокирован, как на узле #36', () => {
    expect(parseTgReach('TG_HTTP=000\n')).toBe('blocked');
  });

  it('нечем проверить или вывод пустой — не приговор серверу', () => {
    expect(parseTgReach('TG_HTTP=none')).toBe('unknown');
    expect(parseTgReach('')).toBe('unknown');
    expect(parseTgReach('bash: curl: command not found')).toBe('unknown');
  });

  it('команда не содержит токена и сама печатает маркер', () => {
    expect(TG_REACH_COMMAND).toContain('TG_HTTP=');
    expect(TG_REACH_COMMAND).not.toMatch(/bot\d/);
  });
});

describe('parseGetMe', () => {
  it('ok:true — бот достаёт', () => {
    expect(parseGetMe('{"ok":true,"result":{"id":1,"username":"x_bot"}}')).toEqual({ ok: true });
  });

  it('401 — токен отвергнут, это не блокировка', () => {
    const r = parseGetMe('{"ok":false,"error_code":401,"description":"Unauthorized"}');
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it('пустой ответ + таймаут curl = блокировка', () => {
    const r = parseGetMe('', 'curl: (28) Connection timed out after 12001 milliseconds');
    expect(r).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('пустой ответ без понятной причины — не блокировка, а unknown', () => {
    expect(parseGetMe('', '')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(parseGetMe('<html>502</html>')).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('getMeConfig', () => {
  it('токен идёт в конфиге для stdin, а не в аргументах команды', () => {
    const cfg = getMeConfig('123:ABC');
    expect(cfg).toContain('https://api.telegram.org/bot123:ABC/getMe');
  });
});

describe('telegramBlockedMessage', () => {
  it('снимает вину с человека и называет выход', () => {
    const m = telegramBlockedMessage('1.2.3.4');
    expect(m).toContain('1.2.3.4');
    expect(m).toContain('Это не твоя ошибка');
    expect(m).toContain('другого');
  });
});
