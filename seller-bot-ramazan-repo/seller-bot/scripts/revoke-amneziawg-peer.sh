#!/usr/bin/env bash
# Удаляет клиента AmneziaWG по его публичному ключу — из живого интерфейса и из конфига.
# Запускается на сервере узла от root. Usage: revoke-amneziawg-peer.sh <CLIENT_PUBKEY>
set -euo pipefail

PUB="${1:?нужен публичный ключ клиента}"
IFACE=awg0
SERVER_CONF=/etc/amnezia/amneziawg/awg0.conf

# 1. Убираем из живого интерфейса (не падаем, если пира уже нет) — доступ отзывается сразу
awg set "$IFACE" peer "$PUB" remove 2>/dev/null || true

# 2. Убираем ровно блок этого клиента из конфига (для персистентности).
#    Построчно по маркеру "### Client": [Interface] и чужие блоки не трогаем.
if [ -f "$SERVER_CONF" ]; then
  awk -v pat="PublicKey = $PUB" '
    /^### Client/ {
      if (block != "") { if (index(block, pat) == 0) printf "%s", block }
      block = $0 "\n"; inblock = 1; next
    }
    { if (inblock) block = block $0 "\n"; else print }
    END { if (block != "" && index(block, pat) == 0) printf "%s", block }
  ' "$SERVER_CONF" > "${SERVER_CONF}.tmp"

  # Guard: перезаписываем ТОЛЬКО если результат непустой и всё ещё содержит [Interface]
  if [ -s "${SERVER_CONF}.tmp" ] && grep -q '^\[Interface\]' "${SERVER_CONF}.tmp"; then
    mv "${SERVER_CONF}.tmp" "$SERVER_CONF"
  else
    rm -f "${SERVER_CONF}.tmp"
    echo "revoke: правку конфига пропустил (проверка не прошла), пир снят с живого интерфейса" >&2
  fi
fi

echo "revoked $PUB"
