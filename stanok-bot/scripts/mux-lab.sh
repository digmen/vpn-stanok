#!/usr/bin/env bash
# A/B одной переменной: мультиплексирование в клиенте (mux) включено или нет. Всё остальное —
# узел, путь, протокол, адреса — одинаковое. Меряем то, что человек ощущает как «медленно»:
# время на короткий запрос и на пачку параллельных запросов (так грузится лента/страница).
#   UUID=… SNI=… WSPATH=… ADDR=… PORT=… bash mux-lab.sh
set -u
run() {  # $1 = метка, $2 = mux-блок JSON
  local S=$((37000 + RANDOM % 2000)) CFG
  CFG=/root/mux-$S.json
  cat > "$CFG" <<JSON
{"log":{"loglevel":"warning"},
 "inbounds":[{"listen":"127.0.0.1","port":$S,"protocol":"socks","settings":{"udp":true}}],
 "outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"$ADDR","port":$PORT,"users":[{"id":"$UUID","encryption":"none"}]}]},
  "streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"$SNI","fingerprint":"chrome"},"wsSettings":{"path":"$WSPATH","headers":{"Host":"$SNI"}}},
  "mux": $2}]}
JSON
  xray run -c "$CFG" > /dev/null 2>&1 &
  local XPID=$!
  sleep 3
  local P="socks5h://127.0.0.1:$S"
  curl -s -o /dev/null -x "$P" -m 10 https://www.google.com/generate_204   # прогрев: у mux первое соединение общее
  local tot=0 t
  for i in $(seq 1 10); do
    t=$(curl -s -o /dev/null -x "$P" -m 10 -w '%{time_total}' https://www.google.com/generate_204)
    tot=$(python3 -c "print($tot + $t)")
  done
  local start end
  start=$(date +%s.%N)
  # Ждём ТОЛЬКО эти запросы: голый `wait` ждал бы и фоновый xray, который не завершается никогда.
  local pids=()
  for i in $(seq 1 20); do curl -s -o /dev/null -x "$P" -m 15 "https://www.tiktok.com/robots.txt?n=$i" & pids+=($!); done
  wait "${pids[@]}"
  end=$(date +%s.%N)
  printf '  %-12s короткий запрос: %4s мс   пачка из 20 параллельных: %s с\n' "$1" \
    "$(python3 -c "print(round($tot / 10 * 1000))")" "$(python3 -c "print(round($end - $start, 2))")"
  kill $XPID 2>/dev/null
  rm -f "$CFG"
}
echo "################ $ADDR:$PORT"
for round in 1 2; do
  run "mux выкл" '{"enabled": false}'
  run "mux вкл" '{"enabled": true, "concurrency": 8, "xudpConcurrency": 16, "xudpProxyUDP443": "reject"}'
done
