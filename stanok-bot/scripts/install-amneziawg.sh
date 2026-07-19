#!/usr/bin/env bash
# Ставит AmneziaWG через установщик wiresock (headless) и выдаёт конфиг автосозданного клиента.
# Usage: install-amneziawg.sh <SERVER_PUBLIC_IP>
set -euo pipefail

SERVER_IP="${1:?Нужен публичный IP сервера первым аргументом}"
INSTALLER=/root/amneziawg-install.sh

export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y curl >/dev/null; }

if [ ! -x "$INSTALLER" ]; then
  curl -fsSL -o "$INSTALLER" \
    https://raw.githubusercontent.com/wiresock/amneziawg-install/main/amneziawg-install.sh
  chmod +x "$INSTALLER"
fi

# Установка (idempotent). AUTO_INSTALL создаёт сервер и первого клиента.
if ! command -v awg >/dev/null 2>&1; then
  AUTO_INSTALL=y SERVER_PUB_IP="$SERVER_IP" bash "$INSTALLER"
fi

# Владельцу отдаём конфиг автосозданного клиента
CONF="$(ls -1 /root/awg0-client-*.conf 2>/dev/null | head -1 || true)"
[ -n "$CONF" ] && [ -f "$CONF" ] || { echo "конфиг клиента не найден после установки" >&2; exit 1; }

echo "###CLIENT_CONFIG_START###"
cat "$CONF"
echo "###CLIENT_CONFIG_END###"
