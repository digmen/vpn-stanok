/**
 * Сквозной тест станка на живом сервере OneDash.
 *
 * Зачем: до 15.08.2026 цепочку проверяли на живых узлах — из 24 провижинингов
 * успешны 4, а причину каждый раз выясняли по переписке. Тест поднимает свой VPS
 * с ГАРАНТИРОВАННЫМ выделенным IP (`static_ip: true` — параметр, а не галочка,
 * которую человек забыл), прогоняет по нему весь провижининг и удаляет сервер.
 *
 *   npx tsx scripts/e2e.ts plan          — что будет сделано и почём (ничего не тратит)
 *   npx tsx scripts/e2e.ts up   --yes    — создать VPS (списывает деньги с баланса)
 *   npx tsx scripts/e2e.ts run           — прогнать провижининг по созданному VPS
 *   npx tsx scripts/e2e.ts down --yes    — удалить VPS (покажет возврат до удаления)
 *   npx tsx scripts/e2e.ts all  --yes    — всё подряд, с удалением в конце
 *
 * Ключ: переменная ONEDASH_API_KEY или файл ~/.secrets/onedash-api.key.
 * Для рискованных методов у ключа должен быть непустой IP whitelist в кабинете.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runRemoteInstall } from '../src/ssh.js';
import { deploySeller } from '../src/deploy-seller.js';
import { checkSshPort } from '../src/preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../.e2e-state.json');
const INSTALL_SCRIPT = path.resolve(__dirname, './install-amneziawg.sh');
const API = 'https://api.rdp-onedash.ru/api';

// Параметры тестового сервера. Самый дешёвый тариф, минимальный срок, обязательно выделенный IP.
const PLAN = {
  tariffName: 'First',
  location: process.env.E2E_LOCATION ?? 'fra',
  processor: process.env.E2E_PROCESSOR ?? 'intel',
  system: process.env.E2E_SYSTEM ?? 'ubuntu_24',
  period: 7,
} as const;

interface State {
  vpsId: number;
  orderId: number;
  host: string;
  createdAt: string;
}

function apiKey(): string {
  const fromEnv = process.env.ONEDASH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.ONEDASH_KEY_FILE ?? path.join(os.homedir(), '.secrets', 'onedash-api.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  throw new Error(`Нет ключа: задай ONEDASH_API_KEY или положи его в ${file}`);
}

async function api<T = any>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const res = await fetch(API + route, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  if (!json?.type) {
    throw new Error(`${method} ${route} → ${res.status} ${json?.err ?? ''} ${json?.message ?? ''}`.trim());
  }
  return json as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readState(): State | null {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : null;
}

async function balance(): Promise<number> {
  return (await api<{ data: { balance: number } }>('GET', '/balance')).data.balance;
}

async function tariff(): Promise<{ id: number; price: number }> {
  const r = await api<{ data: { items: any[] } }>(
    'GET',
    `/tariffs?location=${PLAN.location}&processor=${PLAN.processor}`,
  );
  const item = r.data.items.find((i) => i.name === PLAN.tariffName);
  if (!item) throw new Error(`Тариф ${PLAN.tariffName} не найден в ${PLAN.location}/${PLAN.processor}`);
  const price = item.prices.find((p: any) => p.period === PLAN.period);
  if (!price) throw new Error(`Нет периода ${PLAN.period} дней у тарифа ${PLAN.tariffName}`);
  return { id: item.id, price: price.price };
}

async function cmdPlan(): Promise<void> {
  const [t, bal] = await Promise.all([tariff(), balance()]);
  console.log('План теста:');
  console.log(`  сервер   ${PLAN.tariffName} (id ${t.id}) · ${PLAN.location}/${PLAN.processor} · ${PLAN.system}`);
  console.log(`  срок     ${PLAN.period} дней`);
  console.log(`  цена     ${t.price} ₽ + выделенный IP (цена опции в API не отдаётся)`);
  console.log(`  баланс   ${bal} ₽ → останется примерно ${bal - t.price} ₽`);
  console.log(`  IP       static_ip: true — выставляется параметром, забыть его нельзя`);
  const s = readState();
  console.log(s ? `\n⚠️ Уже есть незакрытый тестовый VPS #${s.vpsId} (${s.host}) от ${s.createdAt}` : '');
}

async function cmdUp(yes: boolean): Promise<void> {
  if (!yes) throw new Error('Создание тратит деньги — нужен флаг --yes');
  if (readState()) throw new Error('Есть незакрытый тестовый VPS. Сначала `down --yes`.');

  const t = await tariff();
  const before = await balance();
  console.log(`Создаю ${PLAN.tariffName} на ${PLAN.period} дней (${t.price} ₽), баланс ${before} ₽…`);

  const created = await api<{ order_id: number }>('POST', '/vps/create', {
    period: PLAN.period,
    tariff_id: t.id,
    location: PLAN.location,
    processor: PLAN.processor,
    system: PLAN.system,
    count: 1,
    additional_options: { static_ip: true, nvme: false, backup: false },
    confirm: true,
  });
  const orderId = created.order_id;
  console.log(`Заказ ${orderId} принят, жду готовности сервера…`);

  // Ждём, пока VPS появится в списке с готовыми реквизитами (создание асинхронное).
  for (let i = 0; i < 60; i++) {
    await sleep(10_000);
    const list = await api<{ data: { items: any[] } }>('GET', '/vps');
    const vps = list.data.items.find((v) => v.order_id === orderId);
    if (vps?.credentials_ready && vps?.connection?.host) {
      const state: State = {
        vpsId: vps.id,
        orderId,
        host: vps.connection.host,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`✅ Сервер #${vps.id} готов: ${state.host} (static_ip: ${vps.options?.static_ip})`);
      console.log(`   баланс стал ${await balance()} ₽`);
      return;
    }
    process.stdout.write('.');
  }
  throw new Error('Сервер не стал готов за 10 минут — проверь кабинет вручную');
}

async function cmdRun(): Promise<void> {
  const state = readState();
  if (!state) throw new Error('Нет тестового VPS. Сначала `up --yes`.');

  const creds = await api<{ data: { login: string; password: string } }>(
    'POST',
    `/vps/${state.vpsId}/credentials`,
    {},
  );
  const password = creds.data.password; // в лог не печатаем

  console.log(`\n1/3 preflight: порт 22 на ${state.host}`);
  let pf = await checkSshPort(state.host);
  for (let i = 0; i < 30 && !pf.ok; i++) {
    process.stdout.write('.');
    await sleep(10_000);
    pf = await checkSshPort(state.host);
  }
  if (!pf.ok) throw new Error(`порт 22 так и не открылся (${pf.reason}) — а IP выделенный, это уже наш баг`);
  console.log('    ✅ отвечает');

  console.log('2/3 ставлю AmneziaWG и забираю клиентский конфиг…');
  const cfg = await runRemoteInstall({
    host: state.host,
    password,
    scriptLocalPath: INSTALL_SCRIPT,
    args: [state.host],
  });
  for (const must of ['[Interface]', '[Peer]', 'PrivateKey', 'Jc', 'S1']) {
    if (!cfg.includes(must)) throw new Error(`в конфиге нет «${must}» — выдача сломана`);
  }
  console.log(`    ✅ конфиг валиден (${cfg.split('\n').length} строк, обфускация на месте)`);

  const sellerToken = process.env.E2E_SELLER_TOKEN?.trim();
  if (!sellerToken) {
    console.log('3/3 бот-продавец пропущен: задай E2E_SELLER_TOKEN (токен тестового бота), чтобы гонять и его');
    return;
  }
  console.log('3/3 разворачиваю бота-продавца…');
  await deploySeller({
    host: state.host,
    password,
    sellerToken,
    ownerId: Number(process.env.E2E_OWNER_ID ?? 0),
    stanokUrl: 'https://t.me/VPNForge_bot',
    priceStars: 1,
  });
  console.log('    ✅ продавец задеплоен и запущен');
}

async function cmdDown(yes: boolean): Promise<void> {
  const state = readState();
  if (!state) throw new Error('Нечего удалять: тестового VPS в состоянии нет.');
  if (!yes) throw new Error('Удаление необратимо — нужен флаг --yes');

  // Предохранитель: удаляем ТОЛЬКО тот сервер, который создали сами. Боевой станок
  // и любые другие серверы аккаунта скрипт тронуть не может физически.
  const list = await api<{ data: { items: any[] } }>('GET', '/vps');
  const vps = list.data.items.find((v) => v.id === state.vpsId);
  if (!vps) {
    console.log(`VPS #${state.vpsId} уже нет в аккаунте — чищу состояние.`);
    rmSync(STATE_FILE);
    return;
  }
  if (vps.connection?.host !== state.host) {
    throw new Error(`#${state.vpsId} теперь отвечает на другой адрес — не трогаю, разберись руками`);
  }

  const info = await api<{ data: any }>('GET', `/vps/${state.vpsId}/delete-info`);
  console.log(
    `Удаляю #${state.vpsId} (${state.host}): возврат ${info.data.refund_amount} ₽, ` +
      `осталось дней ${info.data.days_left}, досрочный сбор ${info.data.early_fee}`,
  );
  await api('POST', `/vps/${state.vpsId}/delete`, { confirm: true });
  rmSync(STATE_FILE);
  console.log(`✅ удалён, баланс ${await balance()} ₽`);
}

const [cmd] = process.argv.slice(2);
const yes = process.argv.includes('--yes');

try {
  if (cmd === 'plan') await cmdPlan();
  else if (cmd === 'up') await cmdUp(yes);
  else if (cmd === 'run') await cmdRun();
  else if (cmd === 'down') await cmdDown(yes);
  else if (cmd === 'all') {
    await cmdUp(yes);
    await cmdRun();
    await cmdDown(yes);
    console.log('\n🎉 Сквозной тест пройден целиком.');
  } else {
    console.log('Команды: plan | up --yes | run | down --yes | all --yes');
  }
} catch (e) {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
