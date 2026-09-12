/**
 * Разовый аудит: каждый узел на WS+TLS проверяется из России двумя путями — напрямую и через
 * релей. Нужен, чтобы решения о релее принимались по замеру, а не по пробе, которая этот
 * протокол проверять не умела. Ссылки берутся из файла (передаётся первым аргументом) и в
 * репозиторий не попадают.
 *
 *   RU_PROBE_HOST=… RU_PROBE_SSH_KEY_PATH=… npx tsx scripts/ru-audit.ts links.json
 */
import { readFileSync } from 'node:fs';
import { testFromRussia, viaRelay } from '../src/ru-probe.js';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { id: number; relay: string | null; link?: string }[];

for (const r of rows) {
  if (!r.link) continue;
  const direct = await testFromRussia(r.link);
  let relayed = null;
  if (r.relay) {
    const [h, p] = r.relay.split(':');
    relayed = await testFromRussia(viaRelay(r.link, h, Number(p)));
  }
  const fmt = (x: typeof direct) => (x === null ? 'не настроена' : `${x.ok ? '✅' : x.inconclusive ? '❔' : '❌'} ${x.detail}`);
  console.log(`#${r.id}\n  напрямую:    ${fmt(direct)}\n  через релей: ${relayed ? fmt(relayed) : '—'}`);
}
