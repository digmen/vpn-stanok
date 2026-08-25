/**
 * Раскатка нового бота-продавца на уже поднятые узлы.
 *
 * Нужна ровно один раз для каждого узла: версии до 0.2.0 не умеют обновляться сами,
 * кнопки «⬆️ Обновление» у них ещё нет. Дальше узлы обновляются кнопкой у владельца,
 * и лезть к ним по SSH больше не придётся.
 *
 *   npm run push-seller -- list           — какие узлы живые и что на них
 *   npm run push-seller -- one <nodeId>   — канарейка: обновить ОДИН узел
 *   npm run push-seller -- rest --yes     — остальные, по одному, с отчётом
 *
 * Данные узла (цены, подписки, клиенты) лежат в /root/seller-bot-data и не трогаются.
 */
import { decrypt } from '../src/crypto.js';
import { getReadyNodes, type NodeRow } from '../src/db.js';
import { deploySeller } from '../src/deploy-seller.js';
import { checkSshPort } from '../src/preflight.js';
import { config } from '../src/config.js';

const [cmd, arg] = process.argv.slice(2);
const yes = process.argv.includes('--yes');

async function pushOne(n: NodeRow): Promise<{ ok: boolean; why?: string }> {
  const pf = await checkSshPort(n.server_ip);
  if (!pf.ok) return { ok: false, why: `сервер не отвечает (${pf.reason})` };
  try {
    await deploySeller({
      host: n.server_ip,
      password: decrypt(n.root_password_enc),
      sellerToken: decrypt(n.seller_token_enc),
      ownerId: n.tg_user_id,
      stanokUrl: config.stanokUrl,
      priceStars: config.sellerPriceStars,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// Только primary: деплой на VPN-точку (is_primary=0) поставил бы ВТОРУЮ копию бота
// с тем же токеном на сервер, где бота вообще не должно быть — ровно баг 25.08 (409,
// ловили дважды на живом клиенте). Обновление доп. локаций не нужно — там нет процесса.
const nodes = getReadyNodes().filter((n) => n.is_primary === 1);

if (cmd === 'list') {
  console.log(`Готовых узлов: ${nodes.length}\n`);
  for (const n of nodes) {
    const pf = await checkSshPort(n.server_ip);
    console.log(`  #${n.id} ${pf.ok ? '🟢' : '🔴'} ${n.server_ip} · @${n.tg_username ?? '—'}`);
  }
} else if (cmd === 'one') {
  const n = nodes.find((x) => String(x.id) === arg);
  if (!n) {
    console.error(`Узел #${arg} не найден среди готовых.`);
    process.exit(1);
  }
  console.log(`Обновляю #${n.id} (${n.server_ip}, @${n.tg_username ?? '—'})…`);
  const r = await pushOne(n);
  console.log(r.ok ? '✅ готово' : `❌ ${r.why}`);
  if (!r.ok) process.exitCode = 1;
} else if (cmd === 'rest') {
  if (!yes) {
    console.error('Это трогает чужие серверы — нужен флаг --yes. Сначала прогони канарейку: one <nodeId>');
    process.exit(1);
  }
  const done = new Set((process.env.SKIP_NODES ?? '').split(',').filter(Boolean));
  let ok = 0;
  const failed: string[] = [];
  // Строго по одному: на слабом VPS npm install съедает всю память.
  for (const n of nodes) {
    if (done.has(String(n.id))) continue;
    process.stdout.write(`#${n.id} ${n.server_ip} … `);
    const r = await pushOne(n);
    if (r.ok) {
      ok++;
      console.log('✅');
    } else {
      failed.push(`#${n.id} ${n.server_ip} — ${r.why}`);
      console.log(`❌ ${r.why}`);
    }
  }
  console.log(`\nИтог: обновлено ${ok}, не удалось ${failed.length}`);
  for (const f of failed) console.log('  ' + f);
} else {
  console.log('Команды: list | one <nodeId> | rest --yes');
}
