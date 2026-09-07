#!/usr/bin/env bash
# Ставит VLESS поверх WebSocket + НАСТОЯЩИЙ TLS (свой домен, сертификат Let's Encrypt).
# Usage: install-vless-ws-tls.sh <SERVER_PUBLIC_IP> <DOMAIN>
#
# 🔴 Зачем он появился (08.09, живой случай, не теория):
# Владелец узла #19 (Грозный, Vainah Telecom) не мог пользоваться своим же VPN. Диагностика
# по логам xray показала: соединение доходит, рукопожатие проходит, мелкие пакеты (DNS) идут,
# а в очереди на отправку ему висят килобайты и не уходят — оператор душит поток. Так вело
# себя Reality и через релей (порт 20019), и напрямую на 443 — то есть дело было НЕ в порту.
# Тот же путь, тот же адрес, но с обычным TLS + WebSocket заработал сразу: 25 Мбит/с по
# Wi-Fi и 144 Мбит/с на мобильном.
#
# Разница принципиальная: Reality ПОДДЕЛЫВАЕТ чужое рукопожатие (притворяется
# addons.mozilla.org, не имея на него прав), и достаточно строгий оператор это ловит.
# Здесь же — свой домен и свой валидный сертификат: снаружи это неотличимо от захода на
# обычный сайт, потому что это и ЕСТЬ обычное TLS-соединение с настоящим сайтом.
set -euo pipefail

SERVER_IP="${1:?Нужен публичный IP сервера первым аргументом}"
DOMAIN="${2:?Нужен домен вторым аргументом (A-запись должна уже указывать на этот сервер)}"
XRAY_CONF_DIR=/usr/local/etc/xray
XRAY_CONF="$XRAY_CONF_DIR/config.json"
CERT_DIR="$XRAY_CONF_DIR/certs"
PORT=443

export DEBIAN_FRONTEND=noninteractive

# Та же грабля, что и в остальных install-скриптах: свежий VPS первые минуты держит
# dpkg-lock под unattended-upgrades.
wait_for_apt() {
  local waited=0 max=600
  while :; do
    if command -v fuser >/dev/null 2>&1; then
      fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || break
    else
      pgrep -f 'unattended-upgrade|apt-get|/usr/bin/dpkg' >/dev/null 2>&1 || break
    fi
    if [ "$waited" -ge "$max" ]; then
      echo "apt/dpkg занят другим процессом дольше ${max}с — подожди 5-10 минут и запусти снова." >&2
      exit 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
}

wait_for_apt
command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y curl >/dev/null; }
command -v jq >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y jq uuid-runtime >/dev/null; }

if ! command -v xray >/dev/null 2>&1; then
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi

mkdir -p "$XRAY_CONF_DIR" "$CERT_DIR"

# Повторный запуск на уже настроенном узле: ничего не пересоздаём (иначе порвём выданные
# клиентам ссылки), только поднимаем сервис и отдаём ту же ссылку.
if [ -s "$XRAY_CONF" ] && jq -e '.inbounds[] | select(.tag=="ws-tls-in")' "$XRAY_CONF" >/dev/null 2>&1; then
  systemctl enable xray >/dev/null 2>&1 || true
  systemctl restart xray
  FIRST_UUID="$(jq -r '.inbounds[] | select(.tag=="ws-tls-in") | .settings.clients[0].id' "$XRAY_CONF")"
  WS_PATH="$(jq -r '.inbounds[] | select(.tag=="ws-tls-in") | .streamSettings.wsSettings.path' "$XRAY_CONF")"
  LINK="vless://${FIRST_UUID}@${DOMAIN}:${PORT}?type=ws&security=tls&sni=${DOMAIN}&host=${DOMAIN}&path=${WS_PATH//\//%2F}&encryption=none#${DOMAIN}"
  echo "###CLIENT_CONFIG_START###"
  echo "$LINK"
  echo "###CLIENT_CONFIG_END###"
  exit 0
fi

# --- Сертификат ---
# Домен обязан уже указывать на этот сервер, иначе Let's Encrypt не подтвердит владение.
# Ждём распространения DNS, а не падаем сразу: запись создаётся станком прямо перед
# запуском этого скрипта, и пара минут на её разлёт — нормально.
echo "жду, пока $DOMAIN начнёт резолвиться в $SERVER_IP…" >&2
resolved=""
for _ in $(seq 1 30); do
  resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
  [ "$resolved" = "$SERVER_IP" ] && break
  sleep 10
done
if [ "$resolved" != "$SERVER_IP" ]; then
  echo "домен $DOMAIN не указывает на $SERVER_IP (сейчас: ${resolved:-нет ответа}) — сертификат не получить" >&2
  exit 1
fi

command -v certbot >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y certbot >/dev/null; }
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp comment 'acme' >/dev/null 2>&1 || true
  ufw allow "${PORT}/tcp" comment 'vless-ws-tls' >/dev/null 2>&1 || true
fi
# Порт 80 нужен только на время проверки владения доменом.
certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN" >/dev/null 2>&1 || {
  echo "не удалось получить сертификат для $DOMAIN (порт 80 занят или домен не доехал)" >&2
  exit 1
}

# 🔴 Ловушка, пойманная живьём 08.09 на узле #19: xray работает под пользователем `nobody`,
# а /etc/letsencrypt/{live,archive} имеют права 0700 root — процесс не может прочитать
# сертификат и падает с "permission denied", утаскивая за собой ВЕСЬ инбаунд. Поэтому
# кладём копию туда, где её видит сам xray, и обновляем её при каждом продлении.
install_certs() {
  install -m 644 -o nobody -g nogroup "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/fullchain.pem"
  install -m 600 -o nobody -g nogroup "/etc/letsencrypt/live/$DOMAIN/privkey.pem"  "$CERT_DIR/privkey.pem"
}
install_certs

# Без этого сертификат молча протухнет через 90 дней и узел встанет.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/xray-certs.sh <<HOOK
#!/bin/sh
install -m 644 -o nobody -g nogroup /etc/letsencrypt/live/$DOMAIN/fullchain.pem $CERT_DIR/fullchain.pem
install -m 600 -o nobody -g nogroup /etc/letsencrypt/live/$DOMAIN/privkey.pem  $CERT_DIR/privkey.pem
systemctl restart xray
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/xray-certs.sh

# --- Конфиг ---
FIRST_UUID="$(uuidgen)"
# Путь случайный, а не общий /ws: по одинаковому пути у всех узлов сеть операторов
# со временем научится узнавать нас оптом.
WS_PATH="/$(openssl rand -hex 6)"

jq -n \
  --arg uuid "$FIRST_UUID" --arg domain "$DOMAIN" --arg wspath "$WS_PATH" \
  --arg cert "$CERT_DIR/fullchain.pem" --arg key "$CERT_DIR/privkey.pem" \
  --argjson port "$PORT" \
  '{
    log: { loglevel: "warning" },
    api: { tag: "api", listen: "127.0.0.1:10085", services: ["HandlerService", "StatsService"] },
    stats: {},
    policy: { levels: { "0": { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      {
        tag: "ws-tls-in",
        listen: "0.0.0.0", port: $port, protocol: "vless",
        settings: {
          clients: [{ id: $uuid, email: "owner" }],
          decryption: "none"
        },
        streamSettings: {
          network: "ws", security: "tls",
          tlsSettings: {
            serverName: $domain,
            alpn: ["http/1.1"],
            certificates: [{ certificateFile: $cert, keyFile: $key }]
          },
          wsSettings: { path: $wspath }
        }
      }
    ],
    dns: { servers: ["1.1.1.1", "8.8.8.8"], queryStrategy: "UseIPv4" },
    outbounds: [
      { tag: "direct", protocol: "freedom", settings: { domainStrategy: "UseIPv4" } },
      { tag: "blocked", protocol: "blackhole" }
    ],
    routing: { rules: [{ type: "field", ip: ["::/0"], outboundTag: "blocked" }] }
  }' > "$XRAY_CONF"

systemctl enable xray >/dev/null 2>&1 || true
systemctl restart xray

# Проверяем, что сервис реально поднялся: без этого узел уезжает в продакшн "установленным",
# а клиенты получают ссылку в никуда (ровно так и вышло 08.09 с правами на сертификат).
sleep 2
if ! systemctl is-active --quiet xray; then
  echo "xray не запустился после установки:" >&2
  journalctl -u xray --no-pager -n 15 >&2 || true
  exit 1
fi

LINK="vless://${FIRST_UUID}@${DOMAIN}:${PORT}?type=ws&security=tls&sni=${DOMAIN}&host=${DOMAIN}&path=${WS_PATH//\//%2F}&encryption=none#${DOMAIN}"

echo "###CLIENT_CONFIG_START###"
echo "$LINK"
echo "###CLIENT_CONFIG_END###"
