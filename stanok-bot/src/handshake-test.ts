import { execFile } from 'node:child_process';
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
