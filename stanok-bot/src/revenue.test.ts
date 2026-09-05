import { beforeAll, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// db.ts открывает базу прямо при импорте — уводим её во временную папку,
// чтобы тест не тронул живой stanok.db.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-test-')), 'test.db');

type Revenue = typeof import('./revenue.js');
let R: Revenue;
beforeAll(async () => {
  R = await import('./revenue.js');
});

// 🔴 subs.json продавца пережил три поколения формата, и на живых узлах лежат
// все три. Ошибка разбора здесь = неверная цифра, по которой считается процент.
describe('parseSales', () => {
  it('v1/v2: единственный pubkey', () => {
    const s = R.parseSales(JSON.stringify([{ pubkey: 'AAA', expiresAt: 1, stars: 50, days: 30, boughtAt: 100 }]));
    expect(s).toHaveLength(1);
    expect(s[0].stars).toBe(50);
    expect(s[0].fingerprint).toBe('AAA:100');
  });

  it('v3: несколько пиров — отпечаток по первому, продажа одна', () => {
    const s = R.parseSales(
      JSON.stringify([
        { peers: [{ loc: 'local', pubkey: 'AAA' }, { loc: 'l2', pubkey: 'BBB' }], stars: 100, boughtAt: 200 },
      ]),
    );
    expect(s).toHaveLength(1);
    expect(s[0].fingerprint).toBe('AAA:200');
    // Одна покупка на две страны — это ОДНА продажа, а не две.
    expect(s[0].stars).toBe(100);
  });

  it('пробный период попадает в список, но денег в нём нет', () => {
    const s = R.parseSales(JSON.stringify([{ pubkey: 'CCC', expiresAt: 1, days: 3, boughtAt: 300 }]));
    expect(s[0].stars).toBe(0);
  });

  it('мусор и битый json не роняют сбор', () => {
    expect(R.parseSales('не json')).toEqual([]);
    expect(R.parseSales('{}')).toEqual([]);
    expect(R.parseSales(JSON.stringify([null, 5, {}, { stars: 10 }]))).toEqual([]);
  });
});

describe('накопление и процент', () => {
  it('повторный сбор не удваивает продажи', () => {
    const sales = R.parseSales(JSON.stringify([{ pubkey: 'DDD', stars: 70, boughtAt: Date.now() }]));
    expect(R.storeSales(42, sales)).toBe(1);
    expect(R.storeSales(42, sales)).toBe(0); // тот же файл прочитан второй раз
  });

  it('процент считается от звёзд, по явно переданному проценту (не глобальный)', () => {
    expect(R.commission(100, 5)).toBe(5);
    expect(R.commission(100, 10)).toBe(10);
    expect(R.commission(0, 5)).toBe(0);
  });

  it('отчёт не падает на пустой базе узлов', () => {
    expect(Array.isArray(R.revenueReport())).toBe(true);
  });

  // 🔴 06.09: узел без явно включённой доли не должен попадать в отчёт вообще —
  // до этой миграции отчёт молча включал ВСЕ узлы с общим 5%.
  it('узел без revenue_share_percent не попадает в отчёт', async () => {
    const { db } = await import('./db.js');
    db.prepare(
      `INSERT INTO nodes (tg_user_id, server_ip, root_password_enc, seller_token_enc)
       VALUES (999001, '1.2.3.4', 'x', 'y')`,
    ).run();
    const rows = R.revenueReport();
    expect(rows.find((r) => r.serverIp === '1.2.3.4')).toBeUndefined();
  });

  it('узел с включённой долей попадает в отчёт со своим процентом', async () => {
    const { db } = await import('./db.js');
    const info = db
      .prepare(
        `INSERT INTO nodes (tg_user_id, server_ip, root_password_enc, seller_token_enc, revenue_share_percent)
         VALUES (999002, '5.6.7.8', 'x', 'y', 10)`,
      )
      .run();
    const rows = R.revenueReport();
    const row = rows.find((r) => r.serverIp === '5.6.7.8');
    expect(row).toBeDefined();
    expect(row!.sharePercent).toBe(10);
    expect(row!.nodeId).toBe(Number(info.lastInsertRowid));
  });
});
