#!/usr/bin/env bash
# Удаляет клиента VLESS+WS+TLS по его UUID (передаётся как "pubkey" — общий контракт
# vpn.ts не различает протоколы на этом уровне).
# Usage: revoke-vless-ws-tls-peer.sh <CLIENT_UUID>
set -euo pipefail

UUID="${1:?нужен UUID клиента}"
XRAY_CONF=/usr/local/etc/xray/config.json
TAG=ws-tls-in

[ -f "$XRAY_CONF" ] || { echo "нет $XRAY_CONF — WS+TLS не установлен" >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "нет jq в системе" >&2; exit 1; }

BEFORE="$(jq --arg t "$TAG" '[.inbounds[] | select(.tag==$t) | .settings.clients[]] | length' "$XRAY_CONF")"
jq --arg uuid "$UUID" --arg t "$TAG" \
  '(.inbounds[] | select(.tag==$t) | .settings.clients) |= map(select(.id != $uuid))' \
  "$XRAY_CONF" > "${XRAY_CONF}.tmp"
AFTER="$(jq --arg t "$TAG" '[.inbounds[] | select(.tag==$t) | .settings.clients[]] | length' "${XRAY_CONF}.tmp")"

# Тот же guard, что и в остальных revoke-скриптах: применяем правку, только если
# результат разумный — список не опустел целиком и не вырос.
if [ "$AFTER" -le "$BEFORE" ] && [ "$AFTER" -gt 0 ]; then
  mv "${XRAY_CONF}.tmp" "$XRAY_CONF"
  if ! xray api rmu --server=127.0.0.1:10085 -tag="$TAG" "$UUID" >/dev/null 2>&1; then
    echo "xray api недоступен — применяю перезапуском" >&2
    systemctl restart xray
  fi
else
  rm -f "${XRAY_CONF}.tmp"
  echo "revoke: правку конфига пропустил (проверка не прошла)" >&2
  exit 1
fi

echo "revoked $UUID"
