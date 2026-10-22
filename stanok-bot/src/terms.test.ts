import { describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// terms.ts хранит согласие в kv, а kv тянет базу и конфиг — как в support.test.ts: временная база.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-terms-')), 'test.db');

const { TERMS_FULL, TERMS_SHORT, TERMS_VERSION, acceptTerms, hasAcceptedTerms } = await import('./terms.js');

describe('условия владельцев', () => {
  it('влезают в сообщения Telegram: короткий в одно, полный не длиннее трёх', () => {
    expect(TERMS_SHORT.length).toBeLessThan(4096);
    expect(TERMS_FULL.length).toBeLessThan(3 * 3900);
  });

  it('фиксируют главное: чужие данные, 24 часа, 7 суток, без рассылки от имени бота владельца', () => {
    expect(TERMS_FULL).toContain(TERMS_VERSION);
    expect(TERMS_FULL).toContain('24 часов');
    expect(TERMS_FULL).toContain('7 суток');
    expect(TERMS_FULL).toContain('не пишет твоим клиентам от имени твоего бота');
    expect(TERMS_FULL).toContain('не отвечает за простои');
    expect(TERMS_FULL).toContain('Доля с продаж');
  });

  it('честно называет ссылку на франшизу в боте: кнопка, разовое сообщение, можно убрать', () => {
    expect(TERMS_FULL).toContain('Ссылка на франшизу');
    expect(TERMS_FULL).toContain('один раз приходит сообщение');
    expect(TERMS_FULL).toContain('Убрать и кнопку, и сообщение можно');
    expect(TERMS_SHORT).toContain('открытая ссылка на франшизу');
  });

  it('короткая версия говорит, что «Принимаю» = согласие, и ведёт на полный текст', () => {
    expect(TERMS_SHORT).toContain('/terms');
    expect(TERMS_SHORT).toContain('Принимаю');
  });

  it('согласие запоминается: версия и время, у другого человека его нет', () => {
    expect(hasAcceptedTerms(101)).toBe(false);
    acceptTerms(101, new Date('2026-10-22T20:00:00Z'));
    expect(hasAcceptedTerms(101)).toBe(true);
    expect(hasAcceptedTerms(102)).toBe(false);
  });
});
