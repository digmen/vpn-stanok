import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSSH } from 'node-ssh';
import { REMOTE, SSH } from './constants.js';
import { extractClientConfig } from './parse.js';
import { testHandshake, testVlessRealityHandshake } from './handshake-test.js';
import type { NodeProtocol } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Скрипты выдачи/отзыва пира живут в seller-bot (сосед по репозиторию на
// станке — deploy.yml заливает оба каталога рядом), а не дублируются здесь.
// Пара на протокол — см. тот же принцип в seller-bot/src/vpn.ts::SCRIPTS.
//
// 🔴 06.09, живой инцидент: этот код раньше жёстко звал AmneziaWG-скрипты для
// ЛЮБОГО узла. После того как AmneziaWG снесли с трёх узлов (мигрированы на
// VLESS+Reality), монитор начал слать ложные "недоступен: нет awg0.conf —
// AmneziaWG не установлен" по ним каждые 30 минут — сервер живой, просто
// проверялся не тем протоколом. Ветка по node.protocol это чинит.
const SCRIPTS: Record<NodeProtocol, { add: string; revoke: string }> = {
  amneziawg: {
    add: path.resolve(__dirname, '../../seller-bot/scripts/add-amneziawg-peer.sh'),
    revoke: path.resolve(__dirname, '../../seller-bot/scripts/revoke-amneziawg-peer.sh'),
  },
  vless_reality: {
    add: path.resolve(__dirname, '../../seller-bot/scripts/add-vless-reality-peer.sh'),
    revoke: path.resolve(__dirname, '../../seller-bot/scripts/revoke-vless-reality-peer.sh'),
  },
};

export interface RemoteInstallOptions {
  host: string;
  password: string;
  scriptLocalPath: string;
  args?: string[];
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Заходит на сервер по SSH, заливает install-скрипт, запускает его с аргументами
// и возвращает клиентский VPN-конфиг (между маркерами в выводе скрипта).
export async function runRemoteInstall(opts: RemoteInstallOptions): Promise<string> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: opts.host,
    username: SSH.USERNAME,
    password: opts.password,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true, // многие серверы принимают пароль только через keyboard-interactive
  });

  try {
    await ssh.putFile(opts.scriptLocalPath, REMOTE.INSTALL_SCRIPT);
    const argStr = (opts.args ?? []).map(shellQuote).join(' ');
    const res = await ssh.execCommand(`bash ${REMOTE.INSTALL_SCRIPT} ${argStr}`);

    if (res.code !== 0) {
      throw new Error(`install-скрипт упал (code ${res.code}): ${res.stderr || res.stdout}`.slice(0, 500));
    }

    const cfg = extractClientConfig(res.stdout);
    if (!cfg) {
      throw new Error('Не нашёл клиентский конфиг в выводе скрипта');
    }
    return cfg;
  } finally {
    ssh.dispose();
  }
}

export interface NodeHealth {
  ok: boolean;
  detail: string;
}

// Реальная проверка здоровья узла — не «процесс жив», а «VPN реально принимает
// подключение», настоящим handshake со станка (та же техника, что и в
// provision.ts при установке, см. handshake-test.ts).
//
// 🔴 Фикс 26.08 — прошлая версия звала `pm2 pid seller-bot && awg show awg0`.
// Оба условия оказались фиктивными для вторичных локаций:
// 1. `pm2 pid <имя>` возвращает код 0 (успех) даже когда такого процесса
//    вовсе нет — проверено делом. Значит первая половина проверки не могла
//    провалиться никогда, ни для одного узла.
// 2. Вторичные локации (доп. серверы того же владельца) в принципе НЕ
//    запускают свой seller-bot — это архитектурно (см. attach-location.ts):
//    пиры на них выдаёт primary по SSH. Требовать там процесс — требовать
//    того, чего там не может быть по дизайну.
// Итог: мониторинг физически не мог заметить проблему ни на одной
// вторичной локации, только на primary — ровно узел «Амстердам» из живого
// инцидента 25→26.08 ни разу не попал в алерты, хотя был проблемным.
//
// `isPrimary` — единственное, что теперь по-разному проверяется для primary
// (он же должен реально держать процесс бота) и вторичных локаций (они его
// не имеют по дизайну — не спрашиваем).
export async function checkNodeAlive(
  host: string,
  password: string,
  isPrimary: boolean,
  protocol: NodeProtocol,
): Promise<NodeHealth> {
  const scripts = SCRIPTS[protocol];
  const ssh = new NodeSSH();
  let clientPubkey: string | undefined;
  try {
    await ssh.connect({
      host,
      username: SSH.USERNAME,
      password,
      port: SSH.PORT,
      readyTimeout: SSH.READY_TIMEOUT_MS,
      tryKeyboard: true,
    });

    if (isPrimary) {
      // Числовой pid, а не голый код возврата — pm2 молчит с кодом 0 и на
      // несуществующее имя процесса, само по себе это ничего не доказывает.
      const pidRes = await ssh.execCommand('pm2 pid seller-bot');
      if (!/^\d+$/.test(pidRes.stdout.trim())) {
        return { ok: false, detail: 'процесс seller-bot не запущен (pm2 pid пуст)' };
      }
    }

    const remotePath = '/tmp/health-add-peer.sh';
    await ssh.putFile(scripts.add, remotePath);
    const addRes = await ssh.execCommand(`bash ${remotePath}`);
    if (addRes.code !== 0) {
      return { ok: false, detail: 'не удалось выдать тестовый пир: ' + (addRes.stderr || addRes.stdout).slice(0, 200) };
    }
    const config = extractClientConfig(addRes.stdout);
    const pkMatch = addRes.stdout.match(/###CLIENT_PUBKEY###(.+)/);
    clientPubkey = pkMatch?.[1]?.trim();
    if (!config) {
      return { ok: false, detail: 'скрипт выдачи не вернул конфиг' };
    }

    const hs = protocol === 'vless_reality' ? await testVlessRealityHandshake(config) : await testHandshake(config, 8000);
    return hs;
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (clientPubkey) {
      // Подчищаем тестового пира, чтобы мониторинг не копил мусор в конфиге
      // узла — молча, ошибка отзыва не должна портить результат проверки.
      try {
        const revokePath = '/tmp/health-revoke-peer.sh';
        await ssh.putFile(scripts.revoke, revokePath);
        await ssh.execCommand(`bash ${revokePath} ${shellQuote(clientPubkey)}`);
      } catch {
        /* не критично — переживёт мусорную запись до следующей ревокации */
      }
    }
    ssh.dispose();
  }
}
