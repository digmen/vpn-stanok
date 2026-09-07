#!/usr/bin/env bash
# Добавляет клиента VLESS+WS+TLS в конфиг Xray. Запускается на сервере узла от root.
# Контракт вывода тот же, что у add-vless-reality-peer.sh и add-amneziawg-peer.sh:
# ###CLIENT_PUBKEY### (здесь это UUID) + конфиг между маркерами — vpn.ts разбирает
# вывод всех протоколов одним кодом.
set -euo pipefail

XRAY_CONF=/usr/local/etc/xray/config.json
TAG=ws-tls-in
[ -f "$XRAY_CONF" ] || { echo "нет $XRAY_CONF — WS+TLS не установлен (install-vless-ws-tls.sh)" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "нет jq в системе" >&2; exit 1; }

# Инбаунд ищем ПО ТЕГУ, а не по индексу [0]: на мигрированных узлах рядом какое-то время
# живёт старый reality-in, и жёсткий индекс молча добавил бы клиента не туда.
jq -e --arg t "$TAG" '.inbounds[] | select(.tag == $t)' "$XRAY_CONF" >/dev/null 2>&1 \
  || { echo "в конфиге нет инбаунда $TAG" >&2; exit 1; }

PORT="$(jq -r --arg t "$TAG" '.inbounds[] | select(.tag==$t) | .port' "$XRAY_CONF")"
DOMAIN="$(jq -r --arg t "$TAG" '.inbounds[] | select(.tag==$t) | .streamSettings.tlsSettings.serverName' "$XRAY_CONF")"
WS_PATH="$(jq -r --arg t "$TAG" '.inbounds[] | select(.tag==$t) | .streamSettings.wsSettings.path' "$XRAY_CONF")"

UUID="$(uuidgen)"

# flow (xtls-rprx-vision) здесь НЕ указывается — он существует только для TCP+Reality/TLS.
# С WebSocket-транспортом клиент с flow не подключится вообще.
jq --arg uuid "$UUID" --arg t "$TAG" \
  '(.inbounds[] | select(.tag==$t) | .settings.clients) += [{id: $uuid, email: $uuid}]' \
  "$XRAY_CONF" > "${XRAY_CONF}.tmp"
mv "${XRAY_CONF}.tmp" "$XRAY_CONF"

# Живьём, без рестарта: рестарт рвёт сессии всех подключённых, а не только нового.
# У Reality-инбаунда этот приём стабильно не срабатывал (см. комментарий в
# add-vless-reality-peer.sh) — у обычного TLS/WS он работает, ради чего и брался.
# Всё равно не верим exit-коду: xray умеет печатать "Added 0 user(s)" с кодом 0.
apply_live() {
  local tmp out added
  tmp="$(mktemp)"
  jq --arg uuid "$UUID" --arg t "$TAG" \
    '{inbounds: [ .inbounds[] | select(.tag == $t) | {tag, listen, port, protocol, settings: {clients: [{id: $uuid}], decryption: "none"}} ]}' \
    "$XRAY_CONF" > "$tmp"
  out="$(xray api adu --server=127.0.0.1:10085 "$tmp" 2>&1)"
  rm -f "$tmp"
  added="$(echo "$out" | grep -oE 'Added [0-9]+ user' | grep -oE '[0-9]+' || echo 0)"
  [ "$added" -gt 0 ]
}

if ! apply_live; then
  echo "xray api не добавил клиента живьём — применяю перезапуском" >&2
  systemctl restart xray
fi

# Адрес в ссылке — ДОМЕН, а не IP: сертификат выписан на имя, и по IP клиент упрётся
# в несовпадение сертификата. Если у локации включён релей, seller-bot подменит
# host:port на адрес проброса (withVlessHostPort), а параметры sni/host останутся
# доменом — именно так и нужно, проверка сертификата продолжит сходиться.
LINK="vless://${UUID}@${DOMAIN}:${PORT}?type=ws&security=tls&sni=${DOMAIN}&host=${DOMAIN}&path=${WS_PATH//\//%2F}&encryption=none#vless-ws-tls"

echo "###CLIENT_PUBKEY###${UUID}"
cat <<EOF
###CLIENT_CONFIG_START###
$LINK
###CLIENT_CONFIG_END###
EOF
