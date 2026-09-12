#!/usr/bin/env bash
# Клиентская половина стенда XHTTP против WebSocket. Запускается на другом сервере, чем
# сервер стенда, чтобы между ними была настоящая сеть. Меняется ровно одно — транспорт
# (и mux для второго варианта). Замеры те же, что в mux-lab.sh.
#   UUID=… HOST=… CERTSHA=… bash xhttp-lab-client.sh
set -u
HOST=${HOST:?}; UUID=${UUID:?}; CERTSHA=${CERTSHA:?}
# allowInsecure из xray убран — самоподписанный сертификат стенда закрепляем по хешу.
TLS='"security":"tls","tlsSettings":{"serverName":"xlab.test","pinnedPeerCertSha256":"'$CERTSHA'"'

run() {  # $1 метка, $2 порт, $3 streamSettings (без tls-части), $4 mux
  local S=$((38000 + RANDOM % 1500)) CFG
  CFG=/tmp/xl-$S.json
  cat > "$CFG" <<JSON
{"log":{"loglevel":"warning"},
 "inbounds":[{"listen":"127.0.0.1","port":$S,"protocol":"socks","settings":{"udp":true}}],
 "outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"$HOST","port":$2,"users":[{"id":"$UUID","encryption":"none"}]}]},
  "streamSettings":{$3, $TLS, "alpn":$5}},
  "mux":$4}]}
JSON
  xray run -c "$CFG" > /tmp/xl-$S.log 2>&1 &
  local XPID=$!
  sleep 3
  local P="socks5h://127.0.0.1:$S"
  if ! curl -s -o /dev/null -x "$P" -m 10 https://www.google.com/generate_204; then
    echo "  $1: НЕ ПОДКЛЮЧИЛСЯ"; grep -iE "error|fail" /tmp/xl-$S.log | head -3 | sed 's/^/    /'
    kill $XPID 2>/dev/null; rm -f "$CFG" /tmp/xl-$S.log; return
  fi
  local tot=0 t
  for i in $(seq 1 10); do
    t=$(curl -s -o /dev/null -x "$P" -m 10 -w '%{time_total}' https://www.google.com/generate_204)
    tot=$(python3 -c "print($tot + $t)")
  done
  local pids=() start end
  start=$(date +%s.%N)
  for i in $(seq 1 20); do curl -s -o /dev/null -x "$P" -m 15 "https://www.tiktok.com/robots.txt?n=$i" & pids+=($!); done
  wait "${pids[@]}"
  end=$(date +%s.%N)
  local sp
  sp=$(curl -s -o /dev/null -x "$P" -m 10 -r 0-104857600 -w '%{speed_download}' \
    https://mirror.yandex.ru/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso)
  printf '  %-14s запрос %4s мс · пачка 20: %4s с · загрузка %5s Мбит/с\n' "$1" \
    "$(python3 -c "print(round($tot / 10 * 1000))")" "$(python3 -c "print(round($end - $start, 2))")" \
    "$(python3 -c "print(round(${sp:-0} * 8 / 1e6, 1))")"
  kill $XPID 2>/dev/null
  rm -f "$CFG" /tmp/xl-$S.log
}

WS='"network":"ws","wsSettings":{"path":"/w","host":"xlab.test"}'
XH='"network":"xhttp","xhttpSettings":{"path":"/x","host":"xlab.test","mode":"auto"}'
OFF='{"enabled":false}'
MUX='{"enabled":true,"concurrency":8,"xudpConcurrency":16,"xudpProxyUDP443":"reject"}'
echo "################ клиент → $HOST"
XH1='"network":"xhttp","xhttpSettings":{"path":"/x","host":"xlab.test","mode":"stream-one"}'
for round in 1 2; do
  if [ "${ONLY_XHTTP:-}" = 1 ]; then
    run "XHTTP auto"       28444 "$XH"  "$OFF" '["h2"]'
    run "XHTTP stream-one" 28444 "$XH1" "$OFF" '["h2"]'
    continue
  fi
  run "WS (как сейчас)" 28443 "$WS" "$OFF" '["http/1.1"]'
  run "WS + mux"        28443 "$WS" "$MUX" '["http/1.1"]'
  run "XHTTP"           28444 "$XH" "$OFF" '["h2"]'
done
