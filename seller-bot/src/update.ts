import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Самообновление: бот сам смотрит, вышла ли новая версия, и сам её ставит.
// Так владельцу не нужно ждать, пока мы обойдём все узлы по SSH, — а нам не нужно
// лезть root-ом на чужие серверы ради каждой правки текста.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/self-update.sh');
const PKG = path.resolve(__dirname, '../package.json');
const REMOTE_PKG =
  'https://raw.githubusercontent.com/digmen/vpn-stanok/main/seller-bot/package.json';

export function currentVersion(): string {
  try {
    return (JSON.parse(readFileSync(PKG, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REMOTE_PKG, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const pkg = (await res.json()) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// Сравнение по частям: «0.10.0» новее «0.9.0», хотя строкой было бы наоборот.
export function isNewer(remote: string, local: string): boolean {
  const part = (v: string): number[] => v.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const [a, b] = [part(remote), part(local)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export async function checkUpdate(): Promise<{ local: string; remote: string | null; available: boolean }> {
  const local = currentVersion();
  const remote = await latestVersion();
  return { local, remote, available: remote !== null && isNewer(remote, local) };
}

// Запускаем отдельным процессом: pm2 в конце скрипта перезапустит бота,
// то есть убьёт нас самих. Отвязанный процесс это переживёт, дочерний — нет.
export function startSelfUpdate(): void {
  const child = spawn('bash', [SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SELLER_DIR: path.resolve(__dirname, '..') },
  });
  child.unref();
}
