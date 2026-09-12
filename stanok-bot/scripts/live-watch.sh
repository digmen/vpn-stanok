#!/usr/bin/env bash
# Живое наблюдение за ОДНИМ ключом на узле, пока человек открывает приложение. Ничего не
# меняет на сервере — только читает журнал xray и счётчики сокетов.
#   bash live-watch.sh <первые 8 символов uuid или "owner"> <секунд> [фильтр доменов]
# По умолчанию фильтр — TikTok. Печатает: какие адреса открывались (TCP/UDP), сколько раз,
# и сколько байт реально пришло с этих адресов за время наблюдения.
set -u
KEY=${1:?ключ}; SECS=${2:-120}; FILTER=${3:-tiktok|ibyte|byteoversea|ttwstatic|tiktokv|tiktokcdn}
if [ "$KEY" = owner ]; then
  KEY=$(grep -oE "vless://[0-9a-f-]{36}" /root/seller-bot-data/owner-configs.json | head -1 | cut -c9-16)
fi
LOG=/tmp/watch-$$.log
echo "Наблюдаю ключ ${KEY}… ${SECS} с. Пусть человек открывает приложение."
timeout "$SECS" journalctl -u xray -f -n 0 --no-pager 2>/dev/null | grep --line-buffered "email: $KEY" > "$LOG" &
JPID=$!
# Байты от адресов по фильтру: снимаем счётчики сокетов xray каждые 5 с
declare -A seen
end=$((SECONDS + SECS))
while [ $SECONDS -lt $end ]; do
  grep -oE "(tcp|udp):[^ ]+:443" "$LOG" 2>/dev/null | grep -iE "$FILTER" | sed -E 's/^(tcp|udp)://; s/:443$//' | sort -u | while read -r h; do
    getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u
  done > /tmp/watch-ips-$$ 2>/dev/null
  sleep 5
done
wait $JPID 2>/dev/null
echo "--- что открывалось (всего строк: $(wc -l < "$LOG"))"
grep -oE "accepted (tcp|udp):[^ ]+ \[[^]]+\]" "$LOG" | sed -E 's/accepted //; s/:([0-9]+) / /' | grep -iE "$FILTER|blocked" \
  | sort | uniq -c | sort -rn | head -25
echo "--- маршрут: $(grep -c ' >> direct' "$LOG") напрямую, $(grep -c ' -> blocked' "$LOG") заблокировано"
echo "--- живые соединения xray к адресам по фильтру прямо сейчас (получено байт):"
if [ -s /tmp/watch-ips-$$ ]; then
  ss -tni state established 2>/dev/null | awk -v ips="$(tr '\n' ' ' < /tmp/watch-ips-$$)" '
    /^[0-9]/ {peer=$4; sub(/:[0-9]+$/, "", peer); keep=(index(" " ips " ", " " peer " ") > 0); next}
    keep && /bytes_received/ {match($0, /bytes_received:[0-9]+/); print "  " peer "  " substr($0, RSTART+15, RLENGTH-15)}' | sort | head -20
fi
rm -f "$LOG" /tmp/watch-ips-$$
