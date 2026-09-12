#!/usr/bin/env bash
# UDP через туннель пакетами реального размера. Первый замер (iperf3 по умолчанию) дал 75%
# потерь, но iperf на loopback шлёт огромные датаграммы, а QUIC — пакеты ~1200 байт. Меняем
# ровно одну переменную — размер пакета — и проходим несколько скоростей.
#   UUID=… SNI=… WSPATH=… ADDR=… PORT=… LABEL=… bash udp-lab.sh
set -u
U=$((35000 + RANDOM % 4000))
CFG=/root/udp-$U.json
cat > "$CFG" <<JSON
{"log":{"loglevel":"warning"},
 "inbounds":[{"listen":"127.0.0.1","port":$U,"protocol":"dokodemo-door","settings":{"address":"127.0.0.1","port":5201,"network":"tcp,udp"}}],
 "outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"$ADDR","port":$PORT,"users":[{"id":"$UUID","encryption":"none"}]}]},
  "streamSettings":{"network":"ws","security":"tls","tlsSettings":{"serverName":"$SNI","fingerprint":"chrome"},"wsSettings":{"path":"$WSPATH","headers":{"Host":"$SNI"}}}}]}
JSON
xray run -c "$CFG" > /dev/null 2>&1 &
XPID=$!
sleep 3
echo "################ $LABEL"
for rate in 5M 20M 50M; do
  for len in 1200 8000; do
    r=$(iperf3 -c 127.0.0.1 -p $U -u -b $rate -l $len -t 6 -R -f m 2>&1 | awk '/receiver/{print $7, $8, "| потери", $11, $12}' | tail -1)
    printf '  %-4s пакет %-5s → %s\n' "$rate" "$len" "${r:-не прошло}"
  done
done
kill $XPID 2>/dev/null
rm -f "$CFG"
