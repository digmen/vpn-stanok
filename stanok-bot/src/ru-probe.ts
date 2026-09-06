import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileP = promisify(execFile);

// 🔴 07.09: обнаружено живьём (и подтверждено уже сделанным на проекте тестом Александра
// 01-02.09, задокументированным в 02 - Журнал шагов ДО этого случая — не гипотеза): Reality
// маскирует протокол, но не спасает от белого списка на некоторых маршрутах в РФ — узел
// может встать и пройти проверку handshake СО СТАНКА (Прага) и при этом быть недостижим
// для настоящего клиента внутри РФ (см. #16, #18 — оба Финляндия, #12 — Германия, тот же
// код и конфиг). Раньше провижининг проверял только "жив ли протокол вообще", не "жив ли
// он для целевой аудитории". Этот модуль добавляет второй, честный тест — реальное
// подключение с российского сервера (95.181.212.18, наш собственный, российская AS), а не
// со станка. Best-effort: если проба не настроена (нет RU_PROBE_HOST в .env) — тихо
// пропускаем, не блокируем провижининг ради диагностики.
export interface RuProbeResult {
  ok: boolean;
  detail: string;
}

export async function testFromRussia(vlessLink: string, waitMs = 6000): Promise<RuProbeResult | null> {
  const host = config.ruProbe.host;
  const keyPath = config.ruProbe.sshKeyPath;
  if (!host || !keyPath) return null;

  const m = vlessLink.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)\?([^#]*)/i);
  if (!m) return { ok: false, detail: 'не удалось разобрать vless-ссылку для RU-пробы' };
  const params = new URLSearchParams(m[4]);
  const uuid = m[1];
  const targetHost = m[2];
  const port = m[3];
  const pbk = params.get('pbk');
  const sid = params.get('sid');
  const sni = params.get('sni');
  if (!pbk || !sid || !sni) return { ok: false, detail: 'в ссылке нет pbk/sid/sni — не Reality-профиль' };

  const socksPort = 20000 + Math.floor(Math.random() * 10000);
  const tag = Math.random().toString(36).slice(2, 8);
  const clientConfig = JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'socks-in', listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: false } }],
    outbounds: [
      {
        protocol: 'vless',
        settings: { vnext: [{ address: targetHost, port: Number(port), users: [{ id: uuid, encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: { serverName: sni, fingerprint: 'chrome', publicKey: pbk, shortId: sid },
        },
      },
    ],
  });

  // Один SSH-вызов, полностью самоочищающийся: пишет конфиг, поднимает временный xray,
  // тянет реальный HTTP-запрос через SOCKS, гасит процесс и чистит файлы — не оставляет
  // следов на чужом (по факту — нашем же) сервере при сбое посередине.
  // 🔴 `pkill -f "xray run -c ...json"` — ловушка: этот же текст буквально входит в
  // командную строку САМОГО удалённого shell'а, выполняющего весь этот скрипт (он же
  // получен как один аргумент ssh), так что pkill по паттерну матчит и себя тоже —
  // shell убивает сам себя, SSH возвращает 255, хотя curl уже успел отдать результат
  // (поймано живьём 07.09 — stdout был верный, exit code врал). Убиваем по точному
  // PID через `$!`, паттерн никого больше не ищет.
  const remoteScript =
    `printf '%s' '${clientConfig.replace(/'/g, "'\\''")}' > /root/probe-${tag}.json; ` +
    `nohup xray run -c /root/probe-${tag}.json > /root/probe-${tag}.log 2>&1 & ` +
    `XPID=$!; ` +
    `sleep ${Math.ceil(waitMs / 1000)}; ` +
    `curl -s -x socks5h://127.0.0.1:${socksPort} --max-time 8 https://api.ipify.org; ` +
    `kill "$XPID" >/dev/null 2>&1; ` +
    `rm -f /root/probe-${tag}.json /root/probe-${tag}.log; ` +
    `exit 0`;

  try {
    const { stdout } = await execFileP(
      'ssh',
      ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', `root@${host}`, remoteScript],
      { timeout: waitMs + 15000 },
    );
    const ip = stdout.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return { ok: true, detail: `подключение из РФ прошло, вышел через ${ip}` };
    }
    return {
      ok: false,
      detail:
        'подключение из РФ НЕ прошло (сервер отвечает станку, но не российскому клиенту) — похоже, ' +
        'хостинг/страна узла режется на некоторых российских маршрутах. Стоит попробовать другую страну хостинга.',
    };
  } catch (e) {
    return { ok: false, detail: 'RU-проба не смогла даже подключиться к тестовому серверу: ' + (e instanceof Error ? e.message : String(e)) };
  }
}
