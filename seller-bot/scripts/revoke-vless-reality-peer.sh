#!/usr/bin/env bash
# Удаляет клиента VLESS+Reality по его UUID (передаётся как "pubkey" — общий
# контракт vpn.ts не различает протоколы на этом уровне). Запускается на
# сервере узла от root. Usage: revoke-vless-reality-peer.sh <CLIENT_UUID>
set -euo pipefail

UUID="${1:?нужен UUID клиента}"
XRAY_CONF=/usr/local/etc/xray/config.json

[ -f "$XRAY_CONF" ] || { echo "нет $XRAY_CONF — VLESS+Reality не установлен" >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "нет jq в системе" >&2; exit 1; }

BEFORE="$(jq '.inbounds[0].settings.clients | length' "$XRAY_CONF")"
jq --arg uuid "$UUID" \
  '.inbounds[0].settings.clients |= map(select(.id != $uuid))' \
  "$XRAY_CONF" > "${XRAY_CONF}.tmp"
AFTER="$(jq '.inbounds[0].settings.clients | length' "${XRAY_CONF}.tmp")"

# Guard в духе revoke-amneziawg-peer.sh: применяем правку, только если результат
# разумный (не пустой список клиентов, не выросло их число).
if [ "$AFTER" -le "$BEFORE" ] && [ "$AFTER" -gt 0 ]; then
  mv "${XRAY_CONF}.tmp" "$XRAY_CONF"
  TAG="$(jq -r '.inbounds[0].tag' "$XRAY_CONF")"
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
