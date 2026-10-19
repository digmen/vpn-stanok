import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeInstallCommand } from './deploy-seller.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const block = (f: string) => {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  const a = s.indexOf('# >>> distro-lib');
  const b = s.indexOf('# <<< distro-lib');
  return a >= 0 && b > a ? s.slice(a, b) : '';
};

describe('блок distro-lib в install-скриптах', () => {
  it('в обоих VLESS-скриптах он есть и совпадает побайтно', () => {
    const ws = block('install-vless-ws-tls.sh');
    expect(ws).toContain('pm_install');
    expect(block('install-vless-reality.sh')).toBe(ws);
  });
  it('в скриптах не осталось прямых apt-get вне блока', () => {
    for (const f of ['install-vless-ws-tls.sh', 'install-vless-reality.sh']) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8').replace(block(f), '');
      expect(s.split('\n').filter((l) => !l.trim().startsWith('#') && /apt-get|nogroup/.test(l))).toEqual([]);
    }
  });
});

describe('nodeInstallCommand', () => {
  it('покрывает apt, dnf, yum, zypper и pacman', () => {
    const c = nodeInstallCommand();
    for (const pm of ['apt-get', 'dnf', 'yum', 'zypper', 'pacman']) expect(c).toContain(pm);
  });
});
