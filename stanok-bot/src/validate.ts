// Чистые проверки пользовательского ввода. Без побочек — удобно тестировать.

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isValidIpv4(s: string): boolean {
  return IPV4_RE.test(s.trim());
}

// Почему адрес не годится как IP сервера узла.
// Разбор 24 провижинингов (15.08.2026): люди присылают IP из инструкции, из примера в подсказке
// и адреса за NAT. До SSH такие попытки не доходят никогда — отсекаем до запроса пароля.
export type IpProblem =
  | 'not_ip' // не IPv4 вообще
  | 'example' // адрес из документации или из нашего же примера
  | 'private' // приватный, loopback, link-local или CGNAT — сервер за NAT
  | 'reserved'; // multicast/зарезервировано

function inNet(o: number[], net: number[], bits: number): boolean {
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const base = ((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

// Документационные диапазоны (RFC 5737) + 123.45.67.x — пример из наших же подсказок и видео.
// 🔴 13.09: + адреса, которые люди вбивают «для пробы», когда сервера у них ещё нет
// (журнал: 1.1.1.1, 1.2.3.1 — по три «Проверить снова» подряд). Это публичные DNS и
// очевидные заглушки, VPS с таким адресом не бывает — честнее сказать сразу.
const EXAMPLE_NETS: [number[], number][] = [
  [[192, 0, 2, 0], 24],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[123, 45, 67, 0], 24],
  [[1, 2, 3, 0], 24],
  [[1, 1, 1, 1], 32],
  [[1, 0, 0, 1], 32],
  [[8, 8, 8, 8], 32],
  [[8, 8, 4, 4], 32],
  [[9, 9, 9, 9], 32],
  [[77, 88, 8, 8], 32],
];

const PRIVATE_NETS: [number[], number][] = [
  [[10, 0, 0, 0], 8],
  [[172, 16, 0, 0], 12],
  [[192, 168, 0, 0], 16],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[100, 64, 0, 0], 10], // CGNAT — самый частый случай «сервер без выделенного IP»
];

const RESERVED_NETS: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[192, 0, 0, 0], 24],
  [[192, 88, 99, 0], 24],
  [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // зарезервировано + 255.255.255.255
];

// null = адрес годится. Иначе — причина, по которой связываться с ним бессмысленно.
export function checkIp(s: string): IpProblem | null {
  const t = s.trim();
  if (!isValidIpv4(t)) return 'not_ip';
  const o = t.split('.').map(Number);

  if (EXAMPLE_NETS.some(([n, b]) => inNet(o, n, b))) return 'example';
  if (PRIVATE_NETS.some(([n, b]) => inNet(o, n, b))) return 'private';
  if (RESERVED_NETS.some(([n, b]) => inNet(o, n, b))) return 'reserved';
  return null;
}

/**
 * IP из того, что человек прислал, даже если вокруг него лишнее.
 *
 * 🔴 13.09, журнал станка: «194.50.94.6:51187» (с портом) получало «это не похоже на IP» —
 * человек прислал правильный адрес, а бот его отверг. Так же пишут «IP: 1.2.3.4»,
 * «root@1.2.3.4», адрес с пробелами или точкой в конце. Если в тексте ровно один IPv4 —
 * это он и есть; если несколько разных — не угадываем, переспрашиваем.
 */
export function extractIpv4(s: string): string | null {
  const found = new Set<string>();
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\s*\.\s*\d{1,3}){3})(?![\d])/g)) {
    const ip = m[1].replace(/\s+/g, '');
    if (isValidIpv4(ip)) found.add(ip);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Начало отказа «это не IP» — по нему журнал находит, что человек прислал вместо адреса. */
export const NOT_IP_PREFIX = '❌ Не вижу тут IP-адреса';

/**
 * Отказ «это не IP», подобранный под то, что человек прислал.
 * Раньше был один текст на всё — и 22 человека получили его 109 раз подряд.
 */
export function notIpMessage(input: string, attempt: number): string {
  const t = input.trim();
  const noServer = /(нет|не купил|ещё не|еще не|где|как|что|\?|помог|не понима|не знаю)/i.test(t) && !/\d/.test(t);
  const looksDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t) && /[a-z]/i.test(t);
  let why: string;
  if (noServer) {
    why =
      'IP появляется после покупки сервера — это адрес именно твоего сервера. ' +
      'Если сервера ещё нет — сначала купи его: /start → «Как купить сервер».';
  } else if (looksDomain) {
    why = 'Это похоже на адрес сайта, а нужен IP сервера — четыре числа через точку, например как в панели хостинга.';
  } else if (t.includes('@') && !/\d+\.\d+/.test(t)) {
    why = 'Это похоже на почту или ник, а нужен IP сервера — четыре числа через точку.';
  } else {
    why = 'Нужны четыре числа через точку — так выглядит IP сервера.';
  }
  const where =
    '\n\nГде взять: панель хостинга → раздел серверов → твой сервер → строка «IP-адрес». Тот же адрес ' +
    'приходит в письме после покупки.';
  const tail = attempt >= 2 ? '\n\nСервера ещё нет? Напиши /start — покажу, как купить.' : '';
  return `${NOT_IP_PREFIX}. ${why}${where}${tail}\n\nПришли IP:`;
}

export function ipProblemMessage(p: IpProblem): string {
  switch (p) {
    case 'not_ip':
      return notIpMessage('', 0);
    case 'example':
      return '❌ Это адрес из примера или публичный адрес интернета (вроде 1.1.1.1), а не твой сервер. Нужен IP именно твоего сервера — он в панели хостинга, в карточке сервера. Пришли его:';
    case 'private':
      return '❌ Это внутренний адрес (сервер за NAT), снаружи к нему не подключиться. Нужен выделенный IP — в панели хостинга он указан как публичный или внешний. Пришли его:';
    case 'reserved':
      return '❌ Такой адрес не бывает адресом сервера. Проверь в панели хостинга и пришли ещё раз:';
  }
}

// Токен бота Telegram: <цифры>:<35+ символов [A-Za-z0-9_-]>
const BOT_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function isValidBotToken(s: string): boolean {
  return BOT_TOKEN_RE.test(s.trim());
}

export function isNonEmptySecret(s: string): boolean {
  return s.trim().length >= 3;
}
