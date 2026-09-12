#!/usr/bin/env bash
# Что происходит с IPv6-назначением внутри нашего туннеля. Телефон в режиме VPN отдаёт в
# туннель и IPv6, если сеть его даёт (мобильный интернет почти всегда). На узле весь ::/0
# уходит в blackhole. Вопрос: отказ приходит сразу (приложение быстро переключится на IPv4)
# или соединение висит (приложение ждёт таймаута на каждом запросе)?
#   UUID=… SNI=… WSPATH=… ADDR=… PORT=… bash v6-lab.sh
set -u
S=$((36000 + RANDOM % 3000)); D=$((S + 1))
V6=$(dig +short AAAA www.tiktok.com @8.8.8.8 | grep : | head -1)
V4=$(dig +short A www.tiktok.com @8.8.8.8 | grep -E '^[0-9.]+$' | head -1)
CFG=/root/v6-$S.json
cat > "$CFG" <<JSON
{"log":{"loglevel":"warning"},
 "inbounds":[
  {"listen":"127.0.0.1","port":$S,"protocol":"socks","settings":{"udp":true}},
  {"listen":"127.0.0.1","port":$D,"protocol":"dokodemo-door","settings":{"address":"2001:4860:4860::8888","port":53,"network":"udp"}}],
 "outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"$ADDR","port":$PORT,"users":[{"id":"$UUID","encryption":"none"}]}]},
  "streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"$SNI","fingerprint":"chrome"},"wsSettings":{"path":"$WSPATH","headers":{"Host":"$SNI"}}}}]}
JSON
xray run -c "$CFG" > /dev/null 2>&1 &
XPID=$!
sleep 3
echo "  AAAA www.tiktok.com = ${V6:-нет} · A = $V4"
printf '  TCP на IPv4-адрес TikTok:  '
curl -s -o /dev/null -x socks5://127.0.0.1:$S -m 20 -k -w 'код %{http_code}, %{time_total} с\n' -H 'Host: www.tiktok.com' "https://$V4/" || echo "ошибка за $SECONDS"
if [ -n "$V6" ]; then
  printf '  TCP на IPv6-адрес TikTok:  '
  start=$(date +%s.%N)
  curl -s -o /dev/null -x socks5://127.0.0.1:$S -m 20 -k -w 'код %{http_code}' -H 'Host: www.tiktok.com' "https://[$V6]/"; rc=$?
  printf ' (curl %s) за %.1f с\n' "$rc" "$(echo "$(date +%s.%N) - $start" | bc)"
fi
printf '  UDP на IPv6 (DNS 2001:4860:4860::8888): '
start=$(date +%s.%N)
dig +time=5 +tries=1 @127.0.0.1 -p $D tiktok.com A >/dev/null 2>&1 && echo -n "ответ" || echo -n "нет ответа"
printf ' за %.1f с\n' "$(echo "$(date +%s.%N) - $start" | bc)"
kill $XPID 2>/dev/null
rm -f "$CFG"
