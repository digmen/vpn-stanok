#!/usr/bin/env bash
# Бот-продавец обновляет сам себя: тянет свежий код с GitHub, ставит зависимости,
# переключается на новую версию и перезапускается. Если не поднялся — откатывается сам.
#
# Запускается ботом по кнопке владельца (detached), поэтому pm2 restart в конце
# не обрывает установку: скрипт живёт отдельно от процесса бота.
#
# Данные (цены, подписки, клиенты) лежат в отдельной папке и не участвуют вообще.
set -euo pipefail

DIR="${SELLER_DIR:-/root/seller-bot}"
REPO="${SELLER_REPO:-https://github.com/digmen/vpn-stanok}"
BRANCH="${SELLER_BRANCH:-main}"
LOG="${DIR}-update.log"

exec >>"$LOG" 2>&1
echo "=== $(date -Is) обновление начато ==="

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ качаю $REPO ($BRANCH)"
curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" -o "$TMP/src.tgz"
tar xzf "$TMP/src.tgz" -C "$TMP"

SRC="$(find "$TMP" -maxdepth 2 -type d -name seller-bot | head -1)"
[ -d "$SRC" ] || { echo "❌ в архиве нет seller-bot"; exit 1; }

echo "→ собираю новую версию"
rm -rf "$DIR.new"
cp -r "$SRC" "$DIR.new"

# Переносим то, что принадлежит именно этому серверу, а не коду.
for f in .env .owner; do
  [ -f "$DIR/$f" ] && cp "$DIR/$f" "$DIR.new/$f"
done

cd "$DIR.new"
npm install --no-audit --no-fund

echo "→ переключаюсь"
rm -rf "$DIR.prev"
mv "$DIR" "$DIR.prev"
mv "$DIR.new" "$DIR"

pm2 restart seller-bot --update-env || true
sleep 8

if pm2 pid seller-bot >/dev/null 2>&1 && [ -n "$(pm2 pid seller-bot)" ]; then
  echo "✅ $(date -Is) обновление успешно"
  exit 0
fi

echo "❌ бот не поднялся — откатываюсь на предыдущую версию"
rm -rf "$DIR"
mv "$DIR.prev" "$DIR"
pm2 restart seller-bot --update-env || true
echo "↩️ откат выполнен"
exit 1
