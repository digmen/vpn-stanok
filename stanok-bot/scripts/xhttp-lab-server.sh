#!/usr/bin/env bash
# Стенд XHTTP против WebSocket: ОДИН временный xray с двумя входами — WS+TLS и XHTTP+TLS —
# на одинаковом самоподписанном сертификате, на свободных портах. Системный xray сервера не
# трогается. Процесс сам умирает через 40 минут. Печатает UUID для клиента.
#   bash xhttp-lab-server.sh start|stop
set -eu
D=/root/xlab
WS_PORT=28443; XH_PORT=28444
case "${1:-start}" in
stop)
  [ -f $D/pid ] && kill "$(cat $D/pid)" 2>/dev/null || true
  rm -rf $D
  echo "стенд остановлен"
  exit 0 ;;
esac
for p in $WS_PORT $XH_PORT; do
  ss -lnt | grep -q ":$p " && { echo "порт $p занят — стенд не поднимаю" >&2; exit 1; }
done
mkdir -p $D
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
  -subj "/CN=xlab.test" -addext "subjectAltName=DNS:xlab.test" \
  -keyout $D/key.pem -out $D/cert.pem >/dev/null 2>&1
UUID=$(cat /proc/sys/kernel/random/uuid)
cat > $D/server.json <<JSON
{"log":{"loglevel":"warning"},
 "inbounds":[
  {"tag":"ws","port":$WS_PORT,"protocol":"vless","settings":{"clients":[{"id":"$UUID"}],"decryption":"none"},
   "streamSettings":{"network":"ws","security":"tls","tlsSettings":{"alpn":["http/1.1"],"certificates":[{"certificateFile":"$D/cert.pem","keyFile":"$D/key.pem"}]},"wsSettings":{"path":"/w"}}},
  {"tag":"xhttp","port":$XH_PORT,"protocol":"vless","settings":{"clients":[{"id":"$UUID"}],"decryption":"none"},
   "streamSettings":{"network":"xhttp","security":"tls","tlsSettings":{"alpn":["h2","http/1.1"],"certificates":[{"certificateFile":"$D/cert.pem","keyFile":"$D/key.pem"}]},"xhttpSettings":{"path":"/x"}}}],
 "outbounds":[{"protocol":"freedom","settings":{"domainStrategy":"UseIPv4"}}]}
JSON
nohup timeout 2400 xray run -c $D/server.json > $D/server.log 2>&1 &
echo $! > $D/pid
sleep 2
ss -lnt | grep -qE ":($WS_PORT|$XH_PORT) " || { echo "xray не поднялся:" >&2; tail -5 $D/server.log >&2; exit 1; }
echo "UUID=$UUID"
