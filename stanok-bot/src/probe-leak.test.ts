import { beforeAll, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Проба настроена на адрес, где никто не слушает SSH, — она обязана упасть. Проверяем, ЧТО
// она при этом скажет: текст уходит в тревогу в Telegram.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-leak-')), 'test.db');
process.env.RU_PROBE_HOST = '127.0.0.1';
process.env.RU_PROBE_SSH_KEY_PATH = path.join(os.tmpdir(), 'no-such-key');

type Probe = typeof import('./ru-probe.js');
let P: Probe;
beforeAll(async () => {
  P = await import('./ru-probe.js');
});

// 🔴 12.09: упавшая проба положила в сообщение всю команду ssh — вместе с конфигом клиента
// и его ключом. Ключ клиента в чате администратора — это ключ, который уже не секрет.
describe('упавшая проба из РФ', () => {
  it('не выдаёт ключ клиента в тексте ошибки', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const r = await P.testFromRussia(
      `vless://${uuid}@node.example:443?type=ws&security=tls&sni=node.example&host=node.example&path=%2Fsecretpath&encryption=none`,
      100,
    );
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.inconclusive).toBe(true);
    expect(r!.detail).not.toContain(uuid);
    expect(r!.detail).not.toContain('secretpath');
    expect(r!.detail).toContain('RU-проба не выполнилась');
  }, 60_000);
});
