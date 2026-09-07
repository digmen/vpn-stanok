import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { verifyBotToken } from './bot-token.js';

// Цена ошибки здесь несимметрична, поэтому тест именно на границу между вердиктами:
// принять отозванный токен — потерянное время и цикл перезапусков на сервере владельца,
// а вот назвать РАБОЧИЙ токен отозванным из-за сбоя сети — хуже: станок разошлёт живым
// владельцам «у вас отозван токен» и погасит их работающих ботов (см. monitorSellerTokens).
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(impl: () => Promise<unknown> | never): void {
  globalThis.fetch = jest.fn(async () => {
    const body = await impl();
    return { json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe('verifyBotToken', () => {
  test('рабочий токен — ok и username бота', async () => {
    mockFetch(async () => ({ ok: true, result: { username: 'shiro_vpnbot' } }));
    expect(await verifyBotToken('123:AA')).toEqual({ ok: true, username: 'shiro_vpnbot' });
  });

  test('username может не прийти — это не ошибка токена', async () => {
    mockFetch(async () => ({ ok: true, result: {} }));
    expect(await verifyBotToken('123:AA')).toEqual({ ok: true, username: null });
  });

  test('401 — токен действительно отозван', async () => {
    mockFetch(async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    expect(await verifyBotToken('123:AA')).toEqual({ ok: false, reason: 'invalid' });
  });

  test('429 (лимит) — НЕ приговор токену, это network', async () => {
    mockFetch(async () => ({ ok: false, error_code: 429, description: 'Too Many Requests' }));
    expect(await verifyBotToken('123:AA')).toEqual({ ok: false, reason: 'network' });
  });

  test('5xx у Telegram — НЕ приговор токену', async () => {
    mockFetch(async () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }));
    expect(await verifyBotToken('123:AA')).toEqual({ ok: false, reason: 'network' });
  });

  test('сеть недоступна (исключение) — network, а не invalid', async () => {
    mockFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
    });
    expect(await verifyBotToken('123:AA')).toEqual({ ok: false, reason: 'network' });
  });
});
