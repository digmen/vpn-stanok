import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { NodeSSH } from 'node-ssh';
import { decrypt } from './crypto.js';
import { SSH } from './constants.js';
import { getReadyNodes, type NodeRow } from './db.js';

// 🔴 07.09: обнаружено живьём (Ramazan_LS) — хостер пересоздаёт VPS с НОВЫМ IP
// (перезагрузка/переустановка/просто слетело), старый сервер умирает НАВСЕГДА вместе
// со всем, что жило только на нём. Само VPN — не жалко, его ставим заново одной
// командой. А вот `/root/seller-bot-data` — цены, скрытые локации, список доп.
// серверов и ключи к ним, кэш «Мой VPN» — нигде больше не существует, и раньше
// терялось безвозвратно. Теперь станок раз в сутки сам стягивает эту папку к себе
// (маленькая, десятки КБ) — по tg_user_id владельца, не по IP и не по нику (ник
// меняется, узел меняется, а кто завёл бота в BotFather — не меняется никогда).
// При замене primary (см. onboarding.ts::isReplacement) provision.ts кладёт
// последний такой бэкап поверх свежепоставленного бота — владельцу ничего
// настраивать заново не нужно, только прислать новый IP и пароль.
//
// Односерверные scp/tar, а не ssh.putDirectory/getDirectory: putDirectory уже дважды
// в этом проекте молча не докладывал часть файлов при параллельной заливке (concurrency)
// — не разбирались откуда, обходили ручным scp. Один файл-архив эту проблему
// не создаёт вообще.
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve('backups');

function ownerDir(tgUserId: number): string {
  return path.join(BACKUP_DIR, String(tgUserId));
}

function latestPath(tgUserId: number): string {
  return path.join(ownerDir(tgUserId), 'seller-bot-data.tar.gz');
}

export function hasBackup(tgUserId: number): boolean {
  return existsSync(latestPath(tgUserId));
}

export async function backupNode(node: NodeRow): Promise<{ ok: boolean; detail: string }> {
  const ssh = new NodeSSH();
  const remoteTar = `/tmp/seller-bot-data-backup-${node.id}.tar.gz`;
  try {
    await ssh.connect({
      host: node.server_ip,
      username: SSH.USERNAME,
      password: decrypt(node.root_password_enc),
      port: SSH.PORT,
      readyTimeout: SSH.READY_TIMEOUT_MS,
      tryKeyboard: true,
    });

    const tarRes = await ssh.execCommand(`tar czf ${remoteTar} -C /root seller-bot-data 2>&1`);
    if (tarRes.code !== 0) {
      return { ok: false, detail: 'tar на узле упал: ' + (tarRes.stderr || tarRes.stdout).slice(0, 200) };
    }

    mkdirSync(ownerDir(node.tg_user_id), { recursive: true });
    const finalPath = latestPath(node.tg_user_id);
    const tmpPath = finalPath + '.tmp';
    await ssh.getFile(tmpPath, remoteTar);
    await ssh.execCommand(`rm -f ${remoteTar}`).catch(() => {});

    const size = statSync(tmpPath).size;
    if (size < 20) throw new Error(`скачанный архив подозрительно мал (${size} байт) — не заменяю прошлый бэкап`);
    // Атомарная замена: если процесс упадёт посреди скачивания, старый бэкап цел.
    renameSync(tmpPath, finalPath);
    return { ok: true, detail: `${size} байт` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    ssh.dispose();
  }
}

// Раз в сутки: бэкапим ТОЛЬКО живые primary-узлы — на них живёт seller-bot-data,
// у доп. локаций своей копии данных нет (см. attach-location.ts). Best-effort:
// один недоступный узел не должен ронять бэкап остальных.
export async function backupAllPrimaries(): Promise<{ ok: number; fail: number; failures: string[] }> {
  let ok = 0;
  const failures: string[] = [];
  for (const n of getReadyNodes()) {
    if (!n.is_primary) continue;
    const r = await backupNode(n);
    if (r.ok) ok++;
    else failures.push(`#${n.id} (${n.server_ip}, @${n.tg_username ?? '—'}): ${r.detail}`);
  }
  return { ok, fail: failures.length, failures };
}

// Кладёт последний бэкап владельца поверх УЖЕ развёрнутого чистого seller-bot
// (deploySeller успел отработать, дефолтные файлы там уже созданы, restore их
// перезаписывает) и перезапускает процесс — без рестарта pm2 новые файлы не
// подхватятся, seller-bot кэширует settings.json в памяти (уже ловили это 06.09
// на боте Александра, тот же класс бага).
export async function restoreBackup(
  tgUserId: number,
  host: string,
  password: string,
): Promise<{ ok: boolean; restored: boolean; detail: string }> {
  const file = latestPath(tgUserId);
  if (!existsSync(file)) {
    return { ok: true, restored: false, detail: 'бэкапа для этого владельца нет — первый сервер или ещё не снимался (раз в сутки)' };
  }

  const ssh = new NodeSSH();
  const remoteTar = '/tmp/restore-seller-bot-data.tar.gz';
  try {
    await ssh.connect({
      host,
      username: SSH.USERNAME,
      password,
      port: SSH.PORT,
      readyTimeout: SSH.READY_TIMEOUT_MS,
      tryKeyboard: true,
    });
    await ssh.putFile(file, remoteTar);
    const res = await ssh.execCommand(
      `tar xzf ${remoteTar} -C /root && rm -f ${remoteTar} && pm2 restart seller-bot --update-env`,
    );
    if (res.code !== 0) {
      return { ok: false, restored: false, detail: 'распаковка/рестарт упали: ' + (res.stderr || res.stdout).slice(0, 200) };
    }
    return { ok: true, restored: true, detail: 'настройки (цены, локации, кэш «Мой VPN») восстановлены из вчерашнего бэкапа' };
  } catch (e) {
    return { ok: false, restored: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    ssh.dispose();
  }
}
