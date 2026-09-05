import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Живая проверка "сервер реально принимает VPN", а не "скрипт установки не упал".
//
// 🔴 Заведено 25.08 после разбора на живом узле (Александр, вторая локация
// «Амстердам»): станок писал в базу status='ready' сразу после того, как
// install-скрипт вышел с кодом 0 — а был ли сервер реально ДОСТИЖИМ по VPN
// (не заблокирован ли UDP-порт у хостера/провайдера, поднялся ли интерфейс
// НА САМОМ ДЕЛЕ), никто не проверял. Разобрались только когда руками подняли
// тестовый туннель со станка и дождались настоящего handshake.
//
// Станок сам умеет быть VPN-клиентом (те же amneziawg-tools, что и на узлах —
// проверено делом 25.08), поэтому проверка не требует стороннего сервиса:
// берём клиентский конфиг, который install-скрипт и так уже генерирует
// (раньше он просто выбрасывался — см. provision.ts), поднимаем по нему
// временный интерфейс прямо на станке и смотрим на настоящий криптографический
// handshake, не на "процесс жив"/"порт открыт".
export interface ParsedPeerConfig {
  privateKey: string;
  serverPublicKey: string;
  presharedKey?: string;
  endpoint: string;
  obfuscation: Record<string, string>;
}

const FIELD_RE = (name: string) => new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm');

export function parseClientConfig(config: string): ParsedPeerConfig {
  const get = (name: string): string | undefined => config.match(FIELD_RE(name))?.[1]?.trim();

  const privateKey = get('PrivateKey');
  const endpoint = get('Endpoint');
  // [Peer]-секция может быть только одна в клиентском конфиге — PublicKey там и есть сервер.
  const serverPublicKey = get('PublicKey');
  if (!privateKey || !endpoint || !serverPublicKey) {
    throw new Error('в клиентском конфиге не нашлось PrivateKey/Endpoint/PublicKey');
  }

  const obfuscation: Record<string, string> = {};
  for (const name of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4']) {
    const v = get(name);
    if (v) obfuscation[name] = v;
  }

  return { privateKey, serverPublicKey, presharedKey: get('PresharedKey'), endpoint, obfuscation };
}

export interface HandshakeTestResult {
  ok: boolean;
  detail: string;
}

/**
 * Поднимает временный amneziawg-интерфейс на СТАНКЕ по только что выданному
 * клиентскому конфигу и ждёт настоящий handshake от целевого сервера.
 * AllowedIPs намеренно НЕ ставим в 0.0.0.0/0 — тест ничего не роутит через
 * туннель, только проверяет, что рукопожатие вообще происходит.
 */
export async function testHandshake(clientConfig: string, waitMs = 8000): Promise<HandshakeTestResult> {
  const peer = parseClientConfig(clientConfig);
  const iface = `hstest${randomBytes(3).toString('hex')}`;

  const lines = ['[Interface]', `PrivateKey = ${peer.privateKey}`];
  for (const [k, v] of Object.entries(peer.obfuscation)) lines.push(`${k} = ${v}`);
  lines.push('', '[Peer]', `PublicKey = ${peer.serverPublicKey}`);
  if (peer.presharedKey) lines.push(`PresharedKey = ${peer.presharedKey}`);
  // AllowedIPs тут ни на что не влияет по существу — трафик через туннель не шлём,
  // нужен только сам handshake. 169.254.x — link-local, гарантированно ничего не заденет.
  lines.push(`Endpoint = ${peer.endpoint}`, 'AllowedIPs = 169.254.66.66/32', 'PersistentKeepalive = 3');

  const dir = mkdtempSync(path.join(tmpdir(), 'stanok-hstest-'));
  const confPath = path.join(dir, 'test.conf');
  writeFileSync(confPath, lines.join('\n') + '\n', { mode: 0o600 });

  try {
    await execFileP('ip', ['link', 'add', iface, 'type', 'amneziawg']);
    try {
      await execFileP('awg', ['setconf', iface, confPath]);
      await execFileP('ip', ['link', 'set', iface, 'up']);
      await new Promise((r) => setTimeout(r, waitMs));

      const { stdout } = await execFileP('awg', ['show', iface, 'latest-handshakes']);
      // Формат: "<pubkey>\t<unix-seconds>" — 0, если рукопожатия не было ни разу.
      const parts = stdout.trim().split(/\s+/);
      const ts = Number(parts[1] ?? '0');
      if (ts > 0) {
        const secAgo = Math.round(Date.now() / 1000 - ts);
        return { ok: true, detail: `handshake ${secAgo}s назад` };
      }
      return { ok: false, detail: 'сервер поднялся, но handshake не случился за ' + waitMs / 1000 + 'с — вероятно, UDP-порт до него не доходит (провайдер/firewall)' };
    } finally {
      await execFileP('ip', ['link', 'del', iface]).catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: 'не удалось поднять тестовый туннель на станке: ' + msg.slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- VLESS+Reality: тот же принцип проверки ("реально работает", не "скрипт не упал"),
// другой механизм — Reality не умеет голого криптографического handshake без полного
// TLS-рукопожатия, поэтому вместо awg-интерфейса поднимаем временный Xray-клиент
// (SOCKS-инбаунд на loopback) и тянем через него реальный HTTP-запрос. Это буквально
// автоматизация того, что руками делали на пражском стенде 31.08 (curl через SOCKS,
// api.ipify.org вернул адрес сервера — значит трафик реально прошёл через Reality).
//
// Требует бинарник `xray` на самом станке. Он там есть (поставлен вручную во время
// теста 31.08) — если станок когда-нибудь переедет на чистую машину, этот бинарник
// придётся поставить заново тем же официальным установщиком, что и на узлах.

const VLESS_LINK_RE =
  /^vless:\/\/([^@]+)@([^:/?#]+):(\d+)\?([^#]*)/i;

interface ParsedVlessLink {
  uuid: string;
  host: string;
  port: number;
  pbk: string;
  sni: string;
  sid: string;
  flow: string;
}

export function parseVlessRealityLink(link: string): ParsedVlessLink {
  const m = link.match(VLESS_LINK_RE);
  if (!m) throw new Error('не похоже на vless-ссылку: ' + link.slice(0, 100));
  const params = new URLSearchParams(m[4]);
  const pbk = params.get('pbk');
  const sni = params.get('sni');
  const sid = params.get('sid');
  if (!pbk || !sni || !sid) throw new Error('в vless-ссылке нет pbk/sni/sid — не Reality-профиль');
  return {
    uuid: m[1],
    host: m[2],
    port: Number(m[3]),
    pbk,
    sni,
    sid,
    flow: params.get('flow') ?? '',
  };
}

async function xrayAvailable(): Promise<boolean> {
  try {
    await execFileP('xray', ['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Поднимает временный Xray-клиент на СТАНКЕ, направленный на только что
 * установленный VLESS+Reality-сервер, и тянет через него реальный HTTP-запрос.
 * Успех = запрос прошёл и вернул осмысленный ответ — не просто "процесс не упал".
 */
export async function testVlessRealityHandshake(link: string, waitMs = 5000): Promise<HandshakeTestResult> {
  if (!(await xrayAvailable())) {
    return { ok: false, detail: 'на станке нет бинарника xray — проверка невозможна, ставь его вручную (см. комментарий в коде)' };
  }

  let peer: ParsedVlessLink;
  try {
    peer = parseVlessRealityLink(link);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const socksPort = 20000 + Math.floor(Math.random() * 10000);
  const dir = mkdtempSync(path.join(tmpdir(), 'stanok-vless-hstest-'));
  const confPath = path.join(dir, 'client.json');
  const clientConfig = {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: false } }],
    outbounds: [
      {
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: peer.host,
              port: peer.port,
              users: [{ id: peer.uuid, encryption: 'none', flow: peer.flow || undefined }],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: { serverName: peer.sni, publicKey: peer.pbk, shortId: peer.sid, fingerprint: 'chrome' },
        },
      },
    ],
  };
  writeFileSync(confPath, JSON.stringify(clientConfig), { mode: 0o600 });

  const proc = spawn('xray', ['run', '-c', confPath], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, waitMs));
    const { stdout } = await execFileP(
      'curl',
      ['-fsS', '--max-time', '8', '-x', `socks5h://127.0.0.1:${socksPort}`, 'https://api.ipify.org'],
    );
    const ip = stdout.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return { ok: true, detail: `запрос через Reality прошёл, ответ от api.ipify.org: ${ip}` };
    }
    return { ok: false, detail: 'curl вернул что-то не похожее на IP: ' + ip.slice(0, 100) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail:
        'запрос через Reality не прошёл — сервер поднялся, но трафик не идёт (порт 443 закрыт файрволом хостера?): ' +
        msg.slice(0, 200),
    };
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
