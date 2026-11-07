import { describe, expect, it } from '@jest/globals';
import { DEFAULT_PROTOCOL, PROTOCOLS, parseProtocolCallback, protocolKeyboard, protocolLabel, protocolQuestion } from './protocols.js';
import { humanInstallError } from './install-error.js';
import { TAG_NEW, TAG_PRIMARY } from './attach-location.js';
import { isAuthFailure } from './preflight.js';

describe('выбор протокола', () => {
  it('на выбор все три, рекомендуемый (WS+TLS) первый и он же по умолчанию', () => {
    expect(PROTOCOLS.map((p) => p.id)).toEqual(['vless_ws_tls', 'vless_reality', 'amneziawg']);
    expect(DEFAULT_PROTOCOL).toBe('vless_ws_tls');
  });

  it('callback разбирается туда и обратно, чужое не угадывается', () => {
    for (const p of PROTOCOLS) expect(parseProtocolCallback('proto:' + p.id)).toBe(p.id);
    expect(parseProtocolCallback('proto:wireguard')).toBeNull();
    expect(parseProtocolCallback('provision:5')).toBeNull();
  });

  it('кнопки: по одной на протокол, данные совпадают с разбором', () => {
    const rows = protocolKeyboard().inline_keyboard.flat();
    expect(rows).toHaveLength(3);
    for (const b of rows) expect(parseProtocolCallback((b as { callback_data: string }).callback_data)).not.toBeNull();
  });

  it('в вопросе честно названо приложение и подвох каждого', () => {
    const q = protocolQuestion();
    expect(q).toMatch(/OneXray/);
    expect(q).toMatch(/AmneziaVPN/);
    expect(q).toMatch(/UDP/);
    expect(q).toMatch(/режут/);
  });

  it('подпись для кнопки «Поднять VPN» без эмодзи и без пометки «рекомендую»', () => {
    expect(protocolLabel('vless_ws_tls')).toBe('VLESS + WS + TLS');
    expect(protocolLabel('amneziawg')).toBe('AmneziaWG');
  });
});

describe('ошибка при добавлении сервера: чей это отказ', () => {
  const authErr = 'All configured authentication methods failed';

  it('отказал основной сервер → про основной, а не «пришли данные заново»', () => {
    const t = humanInstallError(`${TAG_PRIMARY} ${authErr}`);
    expect(t).toMatch(/ОСНОВНОЙ/);
    expect(t).toMatch(/Обновить пароль основного/);
    expect(t).not.toMatch(/Пройди настройку заново/);
  });

  it('на основном нет бота → просим пересдать основной, пароль не поминаем', () => {
    const t = humanInstallError(`${TAG_PRIMARY} бот-продавец на нём не найден`);
    expect(t).toMatch(/бота на нём больше нет/);
    expect(t).toMatch(/IP ОСНОВНОГО/);
  });

  it('отказал новый сервер → прежнее поведение про пароль нового', () => {
    expect(humanInstallError(`${TAG_NEW} ${authErr}`)).toMatch(/Сервер не принял root-пароль/);
    expect(humanInstallError(authErr)).toMatch(/Сервер не принял root-пароль/);
  });

  it('метка не мешает распознать отказ по паролю', () => {
    expect(isAuthFailure(`${TAG_PRIMARY} ${authErr}`)).toBe(true);
  });
});
