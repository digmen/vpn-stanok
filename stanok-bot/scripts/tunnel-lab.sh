#!/usr/bin/env bash
# Сквозная лаборатория туннеля: запускается на российском тестовом сервере и проверяет один
# узел WS+TLS тем же клиентом, каким пользуются люди. Всё временное, за собой убирает.
#
#   UUID=… SNI=… WSPATH=… ADDR=… PORT=… LABEL=… bash tunnel-lab.sh
#
# Что меряет и зачем:
#   1. TikTok через туннель — открываются ли его адреса именно ПО ТУННЕЛЮ, а не с сервера;
#   2. UDP через туннель (DNS-запросы) — TikTok тянет видео по QUIC, а это UDP;
#   3. задержка — 10 коротких запросов;
#   4. чистая пропускная способность туннеля — iperf3 до самого узла, мимо интернета;
#   5. UDP-поток iperf3 — потери и дрожание, от них и зависит QUIC;
#   6. реальная загрузка файла из интернета через туннель.
set -u
S=$((30000 + RANDOM % 5000)); D=$((S + 1)); T=$((S + 2)); U=$((S + 3))
CFG=/root/lab-$S.json
cat > "$CFG" <<JSON
{
  "log": {"loglevel": "warning"},
  "inbounds": [
    {"tag": "socks", "listen": "127.0.0.1", "port": $S, "protocol": "socks", "settings": {"udp": true}},
    {"tag": "dns", "listen": "127.0.0.1", "port": $D, "protocol": "dokodemo-door", "settings": {"address": "8.8.8.8", "port": 53, "network": "udp"}},
    {"tag": "iperf-tcp", "listen": "127.0.0.1", "port": $T, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1", "port": 5201, "network": "tcp"}},
    {"tag": "iperf-udp", "listen": "127.0.0.1", "port": $U, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1", "port": 5201, "network": "tcp,udp"}}
  ],
  "outbounds": [{
    "protocol": "vless",
    "settings": {"vnext": [{"address": "$ADDR", "port": $PORT, "users": [{"id": "$UUID", "encryption": "none"}]}]},
    "streamSettings": {"network": "ws", "security": "tls",
      "tlsSettings": {"serverName": "$SNI", "fingerprint": "chrome"},
      "wsSettings": {"path": "$WSPATH", "headers": {"Host": "$SNI"}}}
  }]
}
JSON
xray run -c "$CFG" > /root/lab-$S.log 2>&1 &
XPID=$!
sleep 3
P="socks5h://127.0.0.1:$S"
echo "################ $LABEL ($ADDR:$PORT)"

echo "== 1. TikTok через туннель"
for url in https://www.tiktok.com/ https://m.tiktok.com/ https://api16-normal-c-useast1a.tiktokv.com/ \
           https://api22-normal-c-useast2a.tiktokv.com/ https://sf16-website-login.neutral.ttwstatic.com/; do
  printf '  %-52s ' "$url"
  curl -s -o /dev/null -x "$P" -m 15 -w 'код %{http_code} tls %{time_appconnect}s всего %{time_total}s\n' "$url" || echo "ОШИБКА $?"
done
echo "  выход наружу: $(curl -s -x "$P" -m 10 https://api.ipify.org)"

echo "== 2. UDP через туннель (20 DNS-запросов по UDP)"
ok=0; ms=0
for i in $(seq 1 20); do
  out=$(dig +time=3 +tries=1 @127.0.0.1 -p $D "t$i.tiktok.com" A 2>/dev/null)
  if echo "$out" | grep -q 'status: NOERROR\|status: NXDOMAIN'; then
    ok=$((ok + 1)); ms=$((ms + $(echo "$out" | awk '/Query time/{print $4}')))
  fi
done
echo "  ответили: $ok из 20, среднее $([ $ok -gt 0 ] && echo $((ms / ok)) || echo '—') мс"

echo "== 3. Задержка (10 × маленький запрос)"
tot=0
for i in $(seq 1 10); do
  t=$(curl -s -o /dev/null -x "$P" -m 10 -w '%{time_total}' https://www.google.com/generate_204)
  tot=$(python3 -c "print($tot + $t)")
done
echo "  среднее $(python3 -c "print(round($tot / 10 * 1000))") мс на запрос"

echo "== 4. Пропускная способность туннеля до узла (iperf3, TCP)"
iperf3 -c 127.0.0.1 -p $T -t 8 -R -f m 2>&1 | awk '/receiver/{print "  к клиенту, 1 поток:  " $7, $8}'
iperf3 -c 127.0.0.1 -p $T -t 8 -R -P 4 -f m 2>&1 | awk '/SUM.*receiver/{print "  к клиенту, 4 потока: " $6, $7}'
iperf3 -c 127.0.0.1 -p $T -t 8 -f m 2>&1 | awk '/receiver/{print "  от клиента, 1 поток: " $7, $8}'

echo "== 5. UDP-поток через туннель (iperf3 -u, 20 Мбит/с к клиенту)"
iperf3 -c 127.0.0.1 -p $U -u -b 20M -t 8 -R -f m 2>&1 | awk '/receiver/{print "  " $7, $8, "дрожание", $9, $10, "потери", $11, $12}' | tail -1
[ -z "$(iperf3 -c 127.0.0.1 -p $U -u -b 1M -t 2 -R 2>&1 | grep receiver)" ] && echo "  UDP-поток не прошёл вообще"

echo "== 6. Загрузка файла из интернета через туннель (15 с)"
curl -s -o /dev/null -x "$P" -m 15 -w '  %{speed_download} байт/с\n' https://hel1-speed.hetzner.com/100MB.bin \
  | awk '{printf "  %.1f Мбит/с\n", $1*8/1000000}'

kill $XPID 2>/dev/null
grep -iE 'error|fail' /root/lab-$S.log | head -3 | sed 's/^/  xray: /'
rm -f "$CFG" /root/lab-$S.log
