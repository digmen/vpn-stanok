import { describe, expect, it } from '@jest/globals';
import { extractClientConfig } from './parse.js';

describe('extractClientConfig', () => {
  it('достаёт конфиг между маркерами', () => {
    const out =
      'шум apt\n###CLIENT_CONFIG_START###\n[Interface]\nPrivateKey = x\n###CLIENT_CONFIG_END###\nещё логи';
    expect(extractClientConfig(out)).toBe('[Interface]\nPrivateKey = x');
  });

  it('null, если маркеров нет', () => {
    expect(extractClientConfig('ничего полезного')).toBeNull();
  });
});
