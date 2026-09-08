import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Нет переменной ${name}. Скопируй .env.example → .env и заполни.`);
  }
  return v;
}

function positiveInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} должно быть целым положительным числом, а не "${raw}".`);
  }
  return n;
}

export const config = {
  botToken: required('SELLER_BOT_TOKEN'),
  // id владельца бота (узла) — ему VPN бесплатно + настройки
  ownerId: Number(process.env.OWNER_ID ?? '0'),
  // начальная цена (владелец может поменять в боте — см. price.ts)
  priceStars: positiveInt('PRICE_STARS', 1),
  days: positiveInt('VPN_DAYS', 30),
  stanokUrl: process.env.STANOK_URL ?? 'https://t.me/VPNForge_bot',
  // папка изменяемого состояния (переживает обновления кода). Локально — текущая.
  dataDir: process.env.DATA_DIR ?? '.',
  // Какой протокол установлен НА ЭТОМ сервере (primary/local-локация) — station
  // (provision.ts/deploy-seller.ts) пишет это в .env при разворачивании, до 05.09
  // переменной не было вообще, отсутствие = amneziawg (все узлы были только им).
  // 🔴 08.09: список стал закрытым перечислением, а не сравнением с одним значением.
  // Раньше здесь было `=== 'vless_reality' ? ... : 'amneziawg'`, и появление третьего
  // протокола молча делало бы узел «амнезийным»: бот звал бы AmneziaWG-скрипты на
  // сервере, где их нет. Тот же класс бага, что уже ловили с PRIMARY_PROTOCOL=undefined
  // (узлы #12/#16/#18, 07.09) — неизвестное значение не должно тихо превращаться в
  // рабочее-но-неверное.
  primaryProtocol: ((): 'amneziawg' | 'vless_reality' | 'vless_ws_tls' => {
    const v = process.env.PRIMARY_PROTOCOL;
    if (v === 'vless_reality' || v === 'vless_ws_tls' || v === 'amneziawg') return v;
    if (v) console.warn(`⚠️ PRIMARY_PROTOCOL="${v}" не распознан — считаю amneziawg. Проверь .env узла.`);
    // Пусто = узел заведён до 05.09, когда протокол был один. Это единственный
    // случай, когда умолчание честное.
    return 'amneziawg';
  })(),
  // Доменное имя узла в нашей зоне (nodeN.<зона>) — станок пишет его при разворачивании.
  // Нужно оплате картой: вебхук Tribute должен прийти по HTTPS на настоящее имя с живым
  // сертификатом, а по голому IP сертификата не бывает. Нет домена — оплата картой просто
  // недоступна на этом узле, всё остальное работает как работало.
  nodeDomain: process.env.NODE_DOMAIN || null,
  // Отдельный порт под вебхук: 443 занят самим VPN, а 80 обязан остаться свободным —
  // через него certbot продлевает сертификат.
  tributeWebhookPort: positiveInt('TRIBUTE_WEBHOOK_PORT', 8443),
};
