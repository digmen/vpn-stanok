import { describe, expect, it } from '@jest/globals';
import {
  decideOwnerAlert,
  isOwnerBotSilent,
  downtimeCause,
  MAX_ALERTS,
  ownerDowntimeMessage,
  ownerRecoveredMessage,
  REMIND_EVERY_MS,
  SILENT_AFTER_MS,
} from './downtime.js';

const T0 = 1_000_000_000_000;

describe('decideOwnerAlert', () => {
  it('первый плохой замер только запоминает момент, владельцу не пишет', () => {
    const r = decideOwnerAlert(null, true, T0);
    expect(r.action).toBe('none');
    expect(r.state).toEqual({ since: T0, notified: 0, lastAt: 0 });
  });

  it('до суток молчит', () => {
    const s = { since: T0, notified: 0, lastAt: 0 };
    expect(decideOwnerAlert(s, true, T0 + SILENT_AFTER_MS - 1).action).toBe('none');
  });

  it('ровно через сутки пишет владельцу один раз', () => {
    const s = { since: T0, notified: 0, lastAt: 0 };
    const r = decideOwnerAlert(s, true, T0 + SILENT_AFTER_MS);
    expect(r.action).toBe('alert');
    expect(r.state).toEqual({ since: T0, notified: 1, lastAt: T0 + SILENT_AFTER_MS });
    // следующий замер через 30 минут — тишина
    expect(decideOwnerAlert(r.state, true, T0 + SILENT_AFTER_MS + 30 * 60_000).action).toBe('none');
  });

  it('напоминает не чаще раза в трое суток и не больше трёх сообщений', () => {
    let state = { since: T0, notified: 1, lastAt: T0 + SILENT_AFTER_MS } as ReturnType<typeof decideOwnerAlert>['state'];
    let now = T0 + SILENT_AFTER_MS;
    const sent: string[] = [];
    for (let i = 0; i < 400; i++) {
      now += 30 * 60_000;
      const r = decideOwnerAlert(state, true, now);
      state = r.state;
      if (r.action !== 'none') sent.push(r.action);
    }
    expect(sent).toEqual(['remind', 'remind']);
    expect(state!.notified).toBe(MAX_ALERTS);
  });

  it('первое напоминание ровно через 72 часа после первого сообщения', () => {
    const s = { since: T0, notified: 1, lastAt: T0 };
    expect(decideOwnerAlert(s, true, T0 + REMIND_EVERY_MS - 1).action).toBe('none');
    expect(decideOwnerAlert(s, true, T0 + REMIND_EVERY_MS).action).toBe('remind');
  });

  it('выздоровление до сообщения проходит тихо, после сообщения владельцу объявляется', () => {
    expect(decideOwnerAlert({ since: T0, notified: 0, lastAt: 0 }, false, T0 + 1)).toEqual({ state: null, action: 'none' });
    expect(decideOwnerAlert({ since: T0, notified: 1, lastAt: T0 }, false, T0 + 1)).toEqual({ state: null, action: 'recovered' });
    expect(decideOwnerAlert(null, false, T0).action).toBe('none');
  });

  it('один хороший замер посреди простоя обнуляет отсчёт суток', () => {
    let r = decideOwnerAlert(null, true, T0);
    r = decideOwnerAlert(r.state, false, T0 + 20 * 3600_000);
    r = decideOwnerAlert(r.state, true, T0 + 21 * 3600_000);
    expect(r.state!.since).toBe(T0 + 21 * 3600_000);
    expect(decideOwnerAlert(r.state, true, T0 + 30 * 3600_000).action).toBe('none');
  });
});

describe('downtimeCause', () => {
  it('пароль не подходит → password', () => {
    expect(downtimeCause(0, 'All configured authentication methods failed')).toBe('password');
  });
  it('другая неудача проверки → server', () => {
    expect(downtimeCause(0, 'Timed out while waiting for handshake')).toBe('server');
    // причина неизвестна (записи ещё нет) — «сервер лёг» не заявляем
    expect(downtimeCause(0, null)).toBe('bot');
  });
  it('проверка в порядке или её не было, а бот молчит → bot', () => {
    expect(downtimeCause(1, null)).toBe('bot');
    expect(downtimeCause(null, null)).toBe('bot');
  });
});

describe('тексты владельцу', () => {
  it('для пароля объясняет пересозданный сервер и как настроить заново', () => {
    const m = ownerDowntimeMessage('password', 'shiro_vpnbot', 'alert');
    expect(m).toContain('@shiro_vpnbot');
    expect(m).toContain('пересоздали');
    expect(m).toContain('«Настроить»');
    expect(m).toContain('просто проигнорируй');
  });
  it('напоминание помечено как напоминание', () => {
    expect(ownerDowntimeMessage('server', null, 'remind')).toMatch(/Напоминаю/);
    expect(ownerDowntimeMessage('server', null, 'alert')).toMatch(/больше суток/);
  });
  it('в текстах нет сырых ошибок и обвинений', () => {
    for (const c of ['password', 'server', 'bot'] as const) {
      const m = ownerDowntimeMessage(c, 'x_bot', 'alert');
      expect(m).not.toMatch(/ETIMEDOUT|Error|authentication methods/);
    }
    expect(ownerRecoveredMessage('x_bot')).toContain('@x_bot');
  });
});

describe('isOwnerBotSilent', () => {
  it('накопились необработанные сообщения → молчит, какой бы ни была проверка здоровья', () => {
    expect(isOwnerBotSilent(15, null, null)).toBe(true);
    expect(isOwnerBotSilent(25, 0, 'All configured authentication methods failed')).toBe(true);
    expect(isOwnerBotSilent(1, 1, null)).toBe(true);
  });

  it('станок не может зайти по паролю, но бот забирает сообщения → не молчит (не пугаем зря)', () => {
    expect(isOwnerBotSilent(0, 0, 'All configured authentication methods failed')).toBe(false);
  });

  it('сервер реально не отвечает → молчит, даже если сообщений ещё нет', () => {
    expect(isOwnerBotSilent(0, 0, 'Timed out while waiting for handshake')).toBe(true);
  });

  it('всё в порядке или проверки не было → не молчит', () => {
    expect(isOwnerBotSilent(0, 1, null)).toBe(false);
    expect(isOwnerBotSilent(0, null, null)).toBe(false);
  });
});
