/**
 * Отчёт по воронке станка: кто где отвалился. Запускается там, где лежит база
 * (на сервере — `/root/vpn-franchise/stanok-bot`, локально — по своей копии).
 *
 *   npm run report -- funnel        — сколько людей дошло до каждой ступени
 *   npm run report -- user @nick    — весь путь одного человека (или по telegram id)
 *   npm run report -- recent 20     — кто последний что делал и докуда дошёл
 *   npm run report -- drops         — причины отвала с частотой
 *   добавь --json, чтобы получить машинный вывод
 */
import { dropReasons, funnel, recentUsers, userTimeline } from '../src/events.js';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const json = process.argv.includes('--json');
const [cmd, arg] = args;

function out(data: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

if (cmd === 'funnel') {
  const rows = funnel();
  out(rows, () => {
    const top = rows[0]?.users || 1;
    console.log('Воронка станка (уникальных людей на ступени):\n');
    for (const r of rows) {
      const bar = '█'.repeat(Math.round((r.users / top) * 30));
      console.log(`  ${r.step.padEnd(16)} ${String(r.users).padStart(4)}  ${bar}`);
    }
    for (let i = 1; i < rows.length; i++) {
      const lost = rows[i - 1].users - rows[i].users;
      if (lost > 0) {
        console.log(`\n  ⚠️ ${rows[i - 1].step} → ${rows[i].step}: потеряно ${lost}`);
      }
    }
  });
} else if (cmd === 'user') {
  if (!arg) throw new Error('нужен @username или telegram id');
  const rows = userTimeline(arg);
  out(rows, () => {
    if (rows.length === 0) {
      console.log(`${arg}: в журнале пусто — либо не заходил, либо заходил до 15.08.2026`);
    } else {
      console.log(`Путь ${arg}:\n`);
      for (const r of rows) {
        console.log(`  ${r.created_at}  ${r.step.padEnd(16)} ${r.detail ?? ''}`);
      }
      console.log(`\n  докуда дошёл: ${rows[rows.length - 1].step}`);
    }
  });
} else if (cmd === 'recent') {
  const rows = recentUsers(Number(arg ?? 20));
  out(rows, () => {
    console.log('Последние люди в боте:\n');
    for (const r of rows) console.log(`  ${r.at}  ${r.user.padEnd(20)} ${r.step}`);
  });
} else if (cmd === 'drops') {
  const rows = dropReasons();
  out(rows, () => {
    console.log('Причины отвала:\n');
    for (const r of rows) console.log(`  ${String(r.times).padStart(4)}×  ${r.step.padEnd(16)} ${r.detail ?? ''}`);
  });
} else {
  console.log('Команды: funnel | user <@nick|id> | recent [n] | drops   [--json]');
}
