#!/usr/bin/env bash
# Деплой станка на сервер (запускать с ноутбука из папки vpn-franchise).
# Ставит Node+pm2, заливает код (станок + продавец), запускает станок под pm2.
# Usage: ./deploy-stanok.sh <SERVER_IP>
set -euo pipefail

SERVER="${1:?Usage: ./deploy-stanok.sh <SERVER_IP>}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

[ -f "$ROOT/stanok-bot/.env" ] || {
  echo "❌ Нет stanok-bot/.env. Скопируй stanok-bot/.env.example → .env и заполни BOT_TOKEN и ADMIN_IDS."
  exit 1
}

echo "==> Пакую проект (без node_modules/баз)…"
TAR=/tmp/vpn-franchise.tar.gz
tar --exclude='node_modules' --exclude='.git' --exclude='*.db' --exclude='*.db-shm' \
    --exclude='*.db-wal' -czf "$TAR" -C "$(dirname "$ROOT")" "$(basename "$ROOT")"

echo "==> Заливаю на сервер (введи пароль)…"
scp "$TAR" "root@${SERVER}:/tmp/vpn-franchise.tar.gz"

echo "==> Ставлю Node/pm2, распаковываю, запускаю станок (введи пароль ещё раз)…"
ssh "root@${SERVER}" 'bash -s' <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }
if command -v node >/dev/null 2>&1; then
  echo "→ Node уже есть ($(node -v)) — НЕ трогаю, чтобы не сломать другие приложения на сервере."
else
  echo "→ Node не найден, ставлю Node 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
rm -rf /root/vpn-franchise && mkdir -p /root/vpn-franchise
tar -xzf /tmp/vpn-franchise.tar.gz -C /root/vpn-franchise --strip-components=1
cd /root/vpn-franchise/stanok-bot
npm install --no-audit --no-fund
pm2 delete stanok-bot 2>/dev/null || true
pm2 start npm --name stanok-bot -- start
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
echo "✅ Станок запущен под pm2 (переживёт перезагрузку сервера)."
REMOTE

echo "==> Готово. @VPNForge_bot теперь работает на сервере 24/7."
echo "    Обновить код позже — просто снова запусти этот скрипт."
