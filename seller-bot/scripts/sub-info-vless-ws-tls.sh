#!/usr/bin/env bash
# Read-only: отдаёт параметры узла (домен/порт/путь WS) для сборки ссылки подписки
# по УЖЕ существующему uuid. В отличие от add-vless-ws-tls-peer.sh НИЧЕГО не меняет
# в конфиге xray и не создаёт нового клиента — только читает.
set -euo pipefail

XRAY_CONF=/usr/local/etc/xray/config.json
TAG=ws-tls-in
[ -f "$XRAY_CONF" ] || { echo "нет $XRAY_CONF — WS+TLS не установлен" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "нет jq в системе" >&2; exit 1; }

jq -e --arg t "$TAG" '.inbounds[] | select(.tag == $t)' "$XRAY_CONF" >/dev/null 2>&1 \
  || { echo "в конфиге нет инбаунда $TAG" >&2; exit 1; }

jq -c --arg t "$TAG" \
  '.inbounds[] | select(.tag==$t) | {
     domain: .streamSettings.tlsSettings.serverName,
     port: .port,
     wsPath: .streamSettings.wsSettings.path
   }' "$XRAY_CONF"
