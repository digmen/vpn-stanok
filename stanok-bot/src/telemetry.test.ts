import { beforeAll, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// db.ts открывает базу прямо при импорте — уводим её во временную папку,
// чтобы тест не тронул живой stanok.db.
process.env.BOT_TOKEN ??= '1:test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.DB_PATH ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stanok-test-')), 'test.db');
process.env.ADMIN_IDS ??= '999';

let C: typeof import('./chat-log.js');
let V: typeof import('./validate.js');
let N: typeof import('./nudges.js');
let A: typeof import('./analytics.js');
let E: typeof import('./events.js');
let I: typeof import('./install-error.js');
let db: typeof import('./db.js')['db'];

beforeAll(async () => {
  C = await import('./chat-log.js');
  V = await import('./validate.js');
  N = await import('./nudges.js');
  A = await import('./analytics.js');
  E = await import('./events.js');
  I = await import('./install-error.js');
  db = (await import('./db.js')).db;
});

describe('redact: в журнал диалога не попадает ничего, что даёт доступ', () => {
  it('токен бота — в любом месте текста', () => {
    const t = C.redact('вот токен 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw пришёл');
    expect(t).not.toContain('AAHdq');
    expect(t).toContain('[токен скрыт]');
  });
  it('ключи VPN и конфиги', () => {
    expect(C.redact('лови vless://uuid@node.site:443?type=ws#x')).toBe('лови [ключ vless скрыт]');
    expect(C.redact('[Interface]\nPrivateKey = abc=\nAddress = 10.0.0.2')).toBe('[конфиг VPN скрыт]');
  });
  it('обычный текст не трогаем', () => {
    expect(C.redact('194.50.94.6:51187')).toBe('194.50.94.6:51187');
  });
});

function fakeCtx(userId: number, updateId: number, text: string) {
  return {
    from: { id: userId, username: 'tester' },
    chat: { type: 'private', id: userId },
    update: { update_id: updateId },
    message: { text },
  } as never;
}

describe('журнал входящих', () => {
  it('ответ на шаге пароля пишется как «[пароль скрыт]», команда — как есть', async () => {
    C.markSecretWait(501, 'password');
    await C.logIncoming(fakeCtx(501, 1, 'S3cr3t-Pa$$'), async () => {});
    await C.logIncoming(fakeCtx(501, 2, '/start'), async () => {});
    C.clearSecretWait(501);
    await C.logIncoming(fakeCtx(501, 3, 'а где взять ip?'), async () => {});
    const rows = C.chatTranscript(501);
    expect(rows.map((r) => r.text)).toEqual(['[пароль скрыт]', '/start', 'а где взять ip?']);
    expect(JSON.stringify(rows)).not.toContain('S3cr3t');
  });

  it('один апдейт — одна строка, даже если middleware вызвали дважды', async () => {
    await C.logIncoming(fakeCtx(502, 10, 'привет'), async () => {});
    await C.logIncoming(fakeCtx(502, 10, 'привет'), async () => {});
    expect(C.chatTranscript(502)).toHaveLength(1);
  });

  it('кнопка пишется её надписью', async () => {
    const ctx = {
      from: { id: 503 },
      chat: { type: 'private', id: 503 },
      update: { update_id: 20 },
      callbackQuery: {
        data: 'buy',
        message: { reply_markup: { inline_keyboard: [[{ text: '🛒 Как купить сервер', callback_data: 'buy' }]] } },
      },
    } as never;
    await C.logIncoming(ctx, async () => {});
    expect(C.chatTranscript(503)[0].text).toBe('«🛒 Как купить сервер»');
  });
});

describe('журнал исходящих', () => {
  const prev = (async (_m: string, p: { message_id?: number }) => ({
    ok: true,
    result: { message_id: p.message_id ?? 77 },
  })) as never;

  it('повтор того же вызова (перепроигрывание мастера) не дублирует строку', async () => {
    const payload = { chat_id: 601, text: 'Пришли IP', reply_markup: { inline_keyboard: [[{ text: 'Отмена' }]] } };
    await C.logOutgoing(prev, 'sendMessage', payload as never, undefined);
    await C.logOutgoing(prev, 'sendMessage', payload as never, undefined);
    const rows = C.chatTranscript(601);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Пришли IP\n[кнопки: Отмена]');
  });

  it('ключ VPN в ответе бота вырезается', async () => {
    await C.logOutgoing(prev, 'sendMessage', { chat_id: 602, text: 'твой ключ: vless://secret@x:443' } as never, undefined);
    expect(C.chatTranscript(602)[0].text).toBe('твой ключ: [ключ vless скрыт]');
  });

  it('админу — не пишем (там тревоги и чужие диалоги)', async () => {
    await C.logOutgoing(prev, 'sendMessage', { chat_id: 999, text: 'тревога' } as never, undefined);
    expect(C.chatTranscript(999)).toHaveLength(0);
  });
});

describe('IP из того, что прислали', () => {
  it.each([
    ['194.50.94.6:51187', '194.50.94.6'],
    ['IP: 89.125.120.6', '89.125.120.6'],
    ['root@78.17.115.95', '78.17.115.95'],
    ['91.224.86.107.', '91.224.86.107'],
    ['ssh root@1.2.3.4 -p 22', '1.2.3.4'],
  ])('%s → %s', (input, ip) => {
    expect(V.extractIpv4(input)).toBe(ip);
  });

  it('два разных адреса — не угадываем', () => {
    expect(V.extractIpv4('1.2.3.4 или 5.6.7.8')).toBeNull();
  });
  it('нет адреса — null', () => {
    expect(V.extractIpv4('не знаю')).toBeNull();
  });
  it('живой ввод из журнала «1.1.1.1.in-addr.arpa» — адрес вытащен, но отвергнут как публичный DNS', () => {
    expect(V.checkIp(V.extractIpv4('1.1.1.1.in-addr.arpa')!)).toBe('example');
  });

  it('публичные DNS и заглушки — не адрес сервера', () => {
    expect(V.checkIp('1.1.1.1')).toBe('example');
    expect(V.checkIp('8.8.8.8')).toBe('example');
    expect(V.checkIp('1.2.3.1')).toBe('example');
    expect(V.checkIp('89.125.120.6')).toBeNull();
  });

  it('подсказка подстраивается под ввод', () => {
    expect(V.notIpMessage('а где его взять?', 1)).toContain('после покупки сервера');
    expect(V.notIpMessage('node1.example.com', 1)).toContain('адрес сайта');
    expect(V.notIpMessage('abc', 1)).not.toContain('/start');
    expect(V.notIpMessage('abc', 2)).toContain('/start');
    expect(V.notIpMessage('abc', 2).startsWith(V.NOT_IP_PREFIX)).toBe(true);
  });
});

describe('неверный пароль при установке', () => {
  it('не просит «просто нажать кнопку снова»', () => {
    const t = I.humanInstallError('All configured authentication methods failed');
    expect(t).toContain('не принял root-пароль');
    expect(t).toContain('/start');
  });
});

const H = 3600_000;
function state(over: Partial<import('./analytics.js').UserState>): import('./analytics.js').UserState {
  return {
    id: 1,
    username: 'u',
    firstAt: 1000 * H,
    lastAt: 1000 * H,
    best: 'start',
    failsBeforeOk: null,
    lastFail: null,
    nudges: [],
    off: false,
    ...over,
  };
}

describe('напоминания: когда писать, а когда молчать', () => {
  const since = 900 * H;
  it('после /start и 3 ч тишины — про покупку', () => {
    expect(N.decideNudge(state({}), 1003 * H, since)).toBe('n_buy');
    expect(N.decideNudge(state({}), 1002 * H, since)).toBeNull();
  });
  it('застрял на IP — про IP, на неответившем сервере — про выделенный IP', () => {
    expect(N.decideNudge(state({ best: 'setup_click' }), 1006 * H, since)).toBe('n_ip');
    expect(N.decideNudge(state({ best: 'ip_ok' }), 1006 * H, since)).toBe('n_server');
    expect(N.decideNudge(state({ best: 'token_ok' }), 1006 * H, since)).toBe('n_provision');
  });
  it('старым пользователям (пришли до включения) — никогда', () => {
    expect(N.decideNudge(state({ firstAt: 800 * H, lastAt: 800 * H }), 1003 * H, since)).toBeNull();
  });
  it('«Не напоминать», узел поднят, установка упала — молчим', () => {
    expect(N.decideNudge(state({ off: true }), 1010 * H, since)).toBeNull();
    expect(N.decideNudge(state({ best: 'provision_ok', failsBeforeOk: 0 }), 1010 * H, since)).toBeNull();
    expect(N.decideNudge(state({ best: 'provision_click' }), 1010 * H, since)).toBeNull();
  });
  it('один раз на этап, не больше двух всего, между ними сутки', () => {
    const once = state({ best: 'start', nudges: [{ kind: 'n_buy', at: 1003 * H }] });
    expect(N.decideNudge(once, 1100 * H, since)).toBeNull();
    const progressed = state({ best: 'setup_click', nudges: [{ kind: 'n_buy', at: 1003 * H }] });
    expect(N.decideNudge(progressed, 1010 * H, since)).toBeNull(); // сутки не прошли
    expect(N.decideNudge(progressed, 1030 * H, since)).toBe('n_ip');
    const two = state({ best: 'ip_ok', nudges: [{ kind: 'n_buy', at: 0 }, { kind: 'n_ip', at: 0 }] });
    expect(N.decideNudge(two, 1030 * H, since)).toBeNull();
  });
  it('через 14 дней после прихода — не пишем', () => {
    expect(N.decideNudge(state({}), 1000 * H + 15 * 24 * H, since)).toBeNull();
  });
  it('ночью по Москве — не пишем', () => {
    expect(N.isDaytimeMsk(Date.UTC(2026, 8, 13, 12))).toBe(true); // 15:00 МСК
    expect(N.isDaytimeMsk(Date.UTC(2026, 8, 13, 22))).toBe(false); // 01:00 МСК
  });
});

describe('сводка по людям', () => {
  it('«с первого раза» и ушедшие считаются по журналу', () => {
    const at = (h: number) => new Date(Date.now() - h * H).toISOString().slice(0, 19).replace('T', ' ');
    const ins = db.prepare('INSERT INTO events (tg_user_id, tg_username, step, detail, created_at) VALUES (?, ?, ?, ?, ?)');
    // чистый путь
    for (const s of ['start', 'bought_click', 'setup_click', 'ip_ok', 'preflight_ok', 'password_ok', 'token_ok', 'provision_click', 'provision_ok'])
      ins.run(7001, 'clean', s, null, at(100));
    // путь с ошибкой
    for (const s of ['start', 'setup_click', 'ip_rejected', 'ip_ok', 'preflight_ok', 'password_ok', 'token_ok', 'provision_click', 'provision_ok'])
      ins.run(7002, 'bumpy', s, null, at(100));
    // ушёл на IP 5 дней назад
    for (const s of ['start', 'bought_click', 'setup_click', 'ip_rejected']) ins.run(7003, 'gone', s, 'not_ip', at(120));

    const users = A.loadUserStates();
    const by = (id: number) => users.find((u) => u.id === id)!;
    expect(by(7001).failsBeforeOk).toBe(0);
    expect(by(7002).failsBeforeOk).toBe(1);
    expect(by(7003).failsBeforeOk).toBeNull();
    expect(A.stuckAt(by(7003))).toBe('не смог прислать IP');

    const report = A.funnelReport(30);
    expect(report).toContain('С первого раза, без единой ошибки: 1 из 2');
    expect(report).toContain('@gone (не смог прислать IP)');
    // приглашение — тем, кто до сервера не дошёл; с узлом и «Не напоминать» — нет
    ins.run(7004, 'nope', 'start', null, at(120));
    ins.run(7004, 'nope', 'nudge_off', null, at(119));
    const inv = A.inviteTargets().map((u) => u.id);
    expect(inv).toContain(7003);
    expect(inv).not.toContain(7001);
    expect(inv).not.toContain(7004);
    // шаги напоминаний не считаются действием человека
    E.logEvent({ id: 7003 }, 'nudge', 'n_ip');
    expect(A.loadUserStates().find((u) => u.id === 7003)!.lastAt).toBe(by(7003).lastAt);
  });
});
