import { beforeAll, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// db.ts открывает базу при импорте — уводим её во временную папку.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-setup-')), 'test.db');

type Report = typeof import('./setup-report.js');
let R: Report;
beforeAll(async () => {
  R = await import('./setup-report.js');
});

function node(over: Partial<import('./setup-report.js').NodeSetup> = {}) {
  return {
    nodeId: 19,
    who: '@vasya',
    ok: true,
    hasKey: false,
    bound: 0,
    packages: 3,
    enabled: false,
    webhookSeen: false,
    badSignatures: 0,
    records: [],
    ...over,
  };
}

// 🔴 Смысл отчёта — отличать «человек не начинал» от «человек застрял». Если эти два
// состояния сливаются, отчёт бесполезен: именно ради разницы он и заводился.
describe('на каком шаге владелец', () => {
  it('не начинал — нет ключа', () => {
    expect(R.formatSetupReport([node()])).toContain('не начинал');
  });

  it('ключ есть, но тарифы не привязаны', () => {
    expect(R.formatSetupReport([node({ hasKey: true })])).toContain('тарифы не привязаны');
  });

  it('всё привязано, но приём выключен', () => {
    expect(R.formatSetupReport([node({ hasKey: true, bound: 3 })])).toContain('приём выключен');
  });

  it('приём включён, но адрес в кабинете Tribute не вставлен — событий не приходило', () => {
    const text = R.formatSetupReport([node({ hasKey: true, bound: 3, enabled: true })]);
    expect(text).toContain('не приходило ничего');
  });

  it('чужие подписи — это про ключ, а не про адрес', () => {
    // Стучатся, но подпись не сходится: адрес-то вставлен, беда в другом.
    const text = R.formatSetupReport([node({ hasKey: true, bound: 3, enabled: true, badSignatures: 4 })]);
    expect(text).toContain('не от того кабинета');
  });

  it('работает', () => {
    const text = R.formatSetupReport([node({ hasKey: true, bound: 3, enabled: true, webhookSeen: true })]);
    expect(text).toContain('работает');
  });
});

describe('заминки', () => {
  it('успехи в список проблем не попадают', () => {
    expect(R.isProblem('key-ok')).toBe(false);
    expect(R.isProblem('bind-ok')).toBe(false);
    expect(R.isProblem('enabled')).toBe(false);
    expect(R.isProblem('key-link')).toBe(true);
    expect(R.isProblem('bind-clash')).toBe(true);
    expect(R.isProblem('paid-unbound')).toBe(true);
  });

  it('считаются по всем узлам сразу — ради этого счёта всё и делалось', () => {
    const text = R.formatSetupReport([
      node({ hasKey: true, records: [{ at: Date.now(), event: 'key-link' }] }),
      node({ nodeId: 12, who: '@petya', hasKey: true, records: [{ at: Date.now(), event: 'key-link' }] }),
    ]);
    expect(text).toContain('прислал ссылку вместо ключа — 2');
  });

  it('недоступный узел не роняет отчёт', () => {
    const text = R.formatSetupReport([node({ ok: false, reason: 'таймаут' })]);
    expect(text).toContain('не смог прочитать: таймаут');
  });
});
