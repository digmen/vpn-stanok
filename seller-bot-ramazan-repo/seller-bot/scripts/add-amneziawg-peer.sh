#!/usr/bin/env bash
# Добавляет нового клиента AmneziaWG напрямую через awg (без интерактивного установщика).
# Запускается на сервере узла от root. Печатает клиентский конфиг между маркерами.
set -euo pipefail

IFACE=awg0
SERVER_CONF=/etc/amnezia/amneziawg/awg0.conf
[ -f "$SERVER_CONF" ] || { echo "нет $SERVER_CONF — AmneziaWG не установлен" >&2; exit 1; }
command -v awg >/dev/null 2>&1 || { echo "нет awg в системе" >&2; exit 1; }

val() { awk -v k="$1" -F' *= *' '$1==k{print $2; exit}' "$SERVER_CONF"; }

SERVER_PUB="$(awg show "$IFACE" public-key)"
PORT="$(val ListenPort)"
DNS="1.1.1.1,1.0.0.1"

# Параметры обфускации — ровно как у сервера
JC="$(val Jc)"; JMIN="$(val Jmin)"; JMAX="$(val Jmax)"
S1="$(val S1)"; S2="$(val S2)"; S3="$(val S3)"; S4="$(val S4)"
H1="$(val H1)"; H2="$(val H2)"; H3="$(val H3)"; H4="$(val H4)"

# Подсети берём из адреса сервера (10.66.66.1/24,fd42:42:42:...:1/64)
IFACE_ADDR="$(val Address)"
V4PREFIX="$(echo "$IFACE_ADDR" | cut -d',' -f1 | cut -d'/' -f1)"; V4PREFIX="${V4PREFIX%.*}"
V6BASE="$(echo "$IFACE_ADDR" | cut -d',' -f2 | cut -d'/' -f1)"; V6PREFIX="${V6BASE%:*}:"

# Наименьший СВОБОДНЫЙ последний октет (переиспользуем адреса, освобождённые отзывом)
USED="$(grep -oE 'AllowedIPs = [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' "$SERVER_CONF" | grep -oE '[0-9]+$' | sort -n -u)"
NEXT=""
for i in $(seq 2 254); do
  if ! printf '%s\n' "$USED" | grep -qx "$i"; then NEXT="$i"; break; fi
done
[ -n "$NEXT" ] || { echo "закончились адреса в подсети" >&2; exit 1; }
CLIENT_V4="${V4PREFIX}.${NEXT}"
CLIENT_V6="${V6PREFIX}${NEXT}"

# IP — живым определением через curl, файл установщика — только запасной вариант.
# ПОРТ всегда из живого $PORT (прочитан выше из $SERVER_CONF), а не из старого файла.
# 🔴 Фикс 26.08 (порт): раньше порт тоже брался из awg0-client-*.conf целиком (Endpoint =
# IP:PORT), и если порт на сервере меняли вручную (например, переезд на 443 из-за DPI/
# провайдера) — новые клиенты получали СТАРЫЙ порт. Поймано на Амстердаме, 59234 → 443.
# 🔴 Фикс 26.08 (IP, тот же день, второй заход): тем же вечером Александр сменил IP той
# же VDS через панель OneDash (91.108.248.151), не переустанавливая ОС — файл установщика
# пережил смену IP и продолжал указывать на старый мёртвый адрес (150.251.145.250).
# Новый клиент получал верный порт, но стучался вообще не туда. Приоритет источников
# развёрнут: сперва спрашиваем сервер напрямую (curl), файл — только если curl не ответил.
ENDPOINT_HOST="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$ENDPOINT_HOST" ]; then
  ENDPOINT_HOST="$(grep -hoE 'Endpoint = [0-9.]+:[0-9]+' /root/awg0-client-*.conf 2>/dev/null | head -1 | awk '{print $3}' | cut -d: -f1 || true)"
fi
ENDPOINT="${ENDPOINT_HOST}:${PORT}"

umask 077
CLIENT_PRIV="$(awg genkey)"
CLIENT_PUB="$(printf '%s' "$CLIENT_PRIV" | awg pubkey)"
CLIENT_PSK="$(awg genpsk)"
NAME="c$(date +%s)$RANDOM"

# Регистрируем пира в живом интерфейсе и дописываем в конфиг (переживёт перезагрузку)
awg set "$IFACE" peer "$CLIENT_PUB" preshared-key <(printf '%s' "$CLIENT_PSK") allowed-ips "${CLIENT_V4}/32,${CLIENT_V6}/128"
{
  echo ""
  echo "### Client ${NAME}"
  echo "[Peer]"
  echo "PublicKey = ${CLIENT_PUB}"
  echo "PresharedKey = ${CLIENT_PSK}"
  echo "AllowedIPs = ${CLIENT_V4}/32,${CLIENT_V6}/128"
} >> "$SERVER_CONF"

echo "###CLIENT_PUBKEY###${CLIENT_PUB}"
cat <<EOF
###CLIENT_CONFIG_START###
[Interface]
PrivateKey = ${CLIENT_PRIV}
Address = ${CLIENT_V4}/32,${CLIENT_V6}/128
DNS = ${DNS}
Jc = ${JC}
Jmin = ${JMIN}
Jmax = ${JMAX}
S1 = ${S1}
S2 = ${S2}
S3 = ${S3}
S4 = ${S4}
H1 = ${H1}
H2 = ${H2}
H3 = ${H3}
H4 = ${H4}

[Peer]
PublicKey = ${SERVER_PUB}
PresharedKey = ${CLIENT_PSK}
Endpoint = ${ENDPOINT}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
###CLIENT_CONFIG_END###
EOF
