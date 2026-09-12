import { beforeAll, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-probe-')), 'test.db');

type Probe = typeof import('./ru-probe.js');
type Install = typeof import('./install-error.js');
let P: Probe;
let I: Install;
beforeAll(async () => {
  P = await import('./ru-probe.js');
  I = await import('./install-error.js');
});

const WS = 'vless://u-u-i-d@node22.fleurdelis-club.site:443?type=ws&security=tls&sni=node22.fleurdelis-club.site&host=node22.fleurdelis-club.site&path=%2Fa7a4&encryption=none#x';
const REALITY = 'vless://u-u-i-d@1.2.3.4:443?type=tcp&security=reality&pbk=PBK&sid=ab&sni=addons.mozilla.org&flow=xtls-rprx-vision#x';

// 🔴 11–12.09: проба из РФ умела только Reality. На WS+TLS она «проваливалась» всегда, и по
// этому ложному провалу станок сам включил релей через Прагу трём новым узлам подряд.
describe('проба из РФ понимает оба протокола', () => {
  it('WS+TLS собирается в клиент ws + tls с тем же путём и именем', () => {
    const r = P.clientStream(new URLSearchParams(WS.split('?')[1].split('#')[0]));
    expect('error' in r).toBe(false);
    const s = (r as { stream: Record<string, any> }).stream;
    expect(s.network).toBe('ws');
    expect(s.security).toBe('tls');
    expect(s.tlsSettings.serverName).toBe('node22.fleurdelis-club.site');
    expect(s.wsSettings.path).toBe('/a7a4');
    // У WS+TLS нет flow — с ним xray отказался бы подключаться
    expect((r as { flow?: string }).flow).toBeUndefined();
  });

  it('Reality — как и раньше', () => {
    const r = P.clientStream(new URLSearchParams(REALITY.split('?')[1].split('#')[0]));
    expect((r as { stream: Record<string, any> }).stream.security).toBe('reality');
    expect((r as { flow?: string }).flow).toBe('xtls-rprx-vision');
  });

  it('незнакомый профиль — «не умею проверить», а не «узел плохой»', () => {
    const r = P.clientStream(new URLSearchParams('type=grpc&security=tls'));
    expect('error' in r).toBe(true);
  });

  it('незнакомый профиль в самой пробе помечается как непроверенный', async () => {
    const r = await P.testFromRussia('vless://u@h:443?type=grpc&security=tls');
    // Проба в тесте не настроена (нет RU_PROBE_HOST) — тогда null, и это тоже не провал
    if (r !== null) {
      expect(r.ok).toBe(false);
      expect(r.inconclusive).toBe(true);
    }
  });

  it('ссылка через релей меняет только адрес и порт', () => {
    const r = P.viaRelay(WS, '194.87.126.220', 20022);
    expect(r.startsWith('vless://u-u-i-d@194.87.126.220:20022?')).toBe(true);
    // Имя сервера остаётся настоящим — по нему узел отдаёт свой сертификат
    expect(r).toContain('sni=node22.fleurdelis-club.site');
    expect(r).toContain('path=%2Fa7a4');
  });
});

// 🔴 11.09, узел #21: владелец трижды получил «tput: No value for $TERM» вместо причины и ушёл.
describe('упавшая установка', () => {
  const tput = 'tput: No value for $TERM and no -T specified\n'.repeat(4);

  it('причина из хвоста, мусор tput отброшен', () => {
    const tail = I.meaningfulTail(`${tput}не удалось получить сертификат для node21 (порт 80 занят или домен не доехал)\n`, '');
    expect(tail).toBe('не удалось получить сертификат для node21 (порт 80 занят или домен не доехал)');
  });

  it('цветной вывод не мешает', () => {
    expect(I.meaningfulTail('\x1b[31mошибка\x1b[0m', '')).toBe('ошибка');
  });

  it('пустой stderr — берём stdout', () => {
    expect(I.meaningfulTail(tput, 'шаг 1\nшаг 2 упал')).toBe('шаг 1\nшаг 2 упал');
  });

  it('владелец получает действие, а не сырой вывод', () => {
    expect(I.humanInstallError('не удалось получить сертификат (порт 80 занят)')).toContain('чистый сервер');
    expect(I.humanInstallError('домен node21 не указывает на 1.2.3.4')).toContain('5 минут');
    expect(I.humanInstallError('apt/dpkg занят другим процессом')).toContain('10 минут');
    const unknown = I.humanInstallError('tput: No value for $TERM');
    expect(unknown).not.toContain('tput');
    expect(unknown).toContain('разберусь');
  });
});
