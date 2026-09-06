import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeSSH } from 'node-ssh';
import { SSH } from './constants.js';
import type { NodeRow } from './db.js';

const execFileP = promisify(execFile);

// 🔴 07.09: мультихоп-обход для узлов, недоступных из РФ напрямую (ru-probe.ts
// поймал это на #16/#18 — тот же код и конфиг, что и на рабочем #12, разница
// только в хостинге/стране; проверено вживую: цепочка Москва→Прага→узел
// проходит там, где прямая Москва→узел — нет). Раз станок и есть сама Прага
// (194.87.126.220), первый прыжок отдельно поднимать не нужно — узел просто
// становится доступен клиенту через прозрачный TCP-проброс отсюда.
//
// Сознательно НЕ повторяем xray-чейнинг (dialerProxy) из диагностики 06.09—
// он требовал бы отдельного клиента у себя внутри xray-конфига станка и
// пересборки идентичности (свой uuid/pbk/sid на Праге вместо настоящих узла).
// `socat` как чистый L4-проброс байт проще на порядок и, что важнее, НЕ трогает
// identity клиента: uuid/pbk/sid остаются настоящими узловыми — подписки,
// отзыв пиров у seller-bot продолжают работать как раньше, без единой правки
// в логике учёта клиентов. Замерено: рабочий тест такого чейна (VLESS-вариант)
// давал ~250 Мбит/с — заметно быстрее, чем Hysteria2-вариант оттуда же.
const RELAY_PORT_BASE = 20000;

function relayPortFor(nodeId: number): number {
  return RELAY_PORT_BASE + nodeId;
}

async function ownPublicIp(): Promise<string> {
  const { stdout } = await execFileP('curl', ['-s', '--max-time', '5', 'https://api.ipify.org']);
  const ip = stdout.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('не удалось определить собственный публичный IP станка');
  return ip;
}

async function ensureSocatInstalled(): Promise<void> {
  try {
    await execFileP('which', ['socat']);
  } catch {
    await execFileP('apt-get', ['install', '-y', 'socat']);
  }
}

/** Поднимает (или обновляет) постоянный systemd-юнит проброса порта на самой Праге. */
async function ensureRelayUnit(nodeId: number, targetIp: string, port: number): Promise<void> {
  await ensureSocatInstalled();
  const unitName = `vpn-relay-node${nodeId}.service`;
  const unitPath = `/etc/systemd/system/${unitName}`;
  const unit =
    `[Unit]\nDescription=VPN relay forward for node #${nodeId} (${targetIp}:443)\nAfter=network.target\n\n` +
    `[Service]\nExecStart=/usr/bin/socat TCP-LISTEN:${port},fork,reuseaddr TCP:${targetIp}:443\nRestart=always\nRestartSec=2\n\n` +
    `[Install]\nWantedBy=multi-user.target\n`;
  await execFileP('bash', ['-c', `cat > ${unitPath} <<'EOF'\n${unit}EOF`]);
  await execFileP('systemctl', ['daemon-reload']);
  await execFileP('systemctl', ['enable', '--now', unitName]);
  await execFileP('ufw', ['allow', `${port}/tcp`]).catch(() => {
    /* ufw может отсутствовать/быть выключен — не критично для самого проброса */
  });
}

/** Выключает и убирает релей-юнит для узла (когда узел починили/сменили хостинг). */
export async function disableRelayUnit(nodeId: number): Promise<void> {
  const unitName = `vpn-relay-node${nodeId}.service`;
  await execFileP('systemctl', ['disable', '--now', unitName]).catch(() => {});
  await execFileP('rm', ['-f', `/etc/systemd/system/${unitName}`]).catch(() => {});
  await execFileP('systemctl', ['daemon-reload']).catch(() => {});
}

/**
 * Сообщает seller-bot'у на самом узле новый клиентский адрес (через
 * cli-set-relay.ts — не трогает SSH-адрес узла, только то, что получает
 * клиент в готовой ссылке). Узел is_primary — локация всегда 'local'.
 */
async function pushRelayToNode(node: NodeRow, password: string, relayHost: string, relayPort: number): Promise<void> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: node.server_ip,
    username: SSH.USERNAME,
    password,
    port: SSH.PORT,
    readyTimeout: SSH.READY_TIMEOUT_MS,
    tryKeyboard: true,
  });
  try {
    const res = await ssh.execCommand(`cd /root/seller-bot && npx tsx scripts/cli-set-relay.ts local ${relayHost} ${relayPort}`);
    if (res.code !== 0) {
      throw new Error(`cli-set-relay.ts упал (code ${res.code}): ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
  } finally {
    ssh.dispose();
  }
}

export interface EnableRelayResult {
  host: string;
  port: number;
}

/** Полный цикл включения релея для узла: проброс на Праге + оповещение узла. */
export async function enableRelay(node: NodeRow, password: string): Promise<EnableRelayResult> {
  const port = relayPortFor(node.id);
  const host = await ownPublicIp();
  await ensureRelayUnit(node.id, node.server_ip, port);
  await pushRelayToNode(node, password, host, port);
  return { host, port };
}
