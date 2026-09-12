#!/usr/bin/env bash
# С какими серверами TikTok говорит телефон владельца и телефоны других клиентов. Кластер в
# имени (…-ycru… — Россия, …-sg… — Сингапур, …-useast… — США) показывает, к какому региону
# приложение само себя относит. Запускается на узле, печатает только сводку по доменам.
OWN=$(grep -oE "vless://[0-9a-f-]{36}" /root/seller-bot-data/owner-configs.json | head -1 | cut -c9-)
journalctl -u xray --since -48h --no-pager | grep accepted | grep -iE "tiktokv|tiktok\.com|tiktokcdn|ibyte" > /tmp/tt.log
for u in "$OWN" 2106ea33 a06929cb be7ed03a; do
  tag=""; [ "$u" = "$OWN" ] && tag=" (владелец)"
  echo "--- ключ ${u:0:8}${tag}: всего $(grep -c "$u" /tmp/tt.log)"
  grep "$u" /tmp/tt.log | grep -oE "(tcp|udp):[a-z0-9.-]*(tiktokv|tiktok|tiktokcdn|ibyteimg)[a-z0-9.-]*" \
    | sed -E "s/^(tcp|udp)://; s/[0-9]+-normal/NN-normal/; s/^v[0-9]+[a-z]*\./vNN./; s/^p[0-9]+-/pNN-/" \
    | sort | uniq -c | sort -rn | head -6
  echo "  последний раз: $(grep "$u" /tmp/tt.log | tail -1 | awk '{print $1, $2, $3}')"
done
rm -f /tmp/tt.log
