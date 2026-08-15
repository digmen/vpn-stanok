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
const EXAMPLE_NETS: [number[], number][] = [
  [[192, 0, 2, 0], 24],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[123, 45, 67, 0], 24],
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

export function ipProblemMessage(p: IpProblem): string {
  switch (p) {
    case 'not_ip':
      return '❌ Это не похоже на IP-адрес: нужны четыре числа через точку. Открой панель хостинга — там он написан рядом с сервером. Пришли ещё раз:';
    case 'example':
      return '❌ Это адрес из примера, а не твой. Нужен IP именно твоего сервера — он в панели хостинга, в карточке сервера. Пришли его:';
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
