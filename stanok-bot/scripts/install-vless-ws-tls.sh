#!/usr/bin/env bash
# Ставит VLESS поверх WebSocket + НАСТОЯЩИЙ TLS (свой домен, сертификат Let's Encrypt).
# Usage: install-vless-ws-tls.sh <SERVER_PUBLIC_IP> <DOMAIN>
#
# 🔴 Зачем он появился (08.09, живой случай, не теория):
# Владелец узла #19 (Грозный, Vainah Telecom) не мог пользоваться своим же VPN. Диагностика
# по логам xray показала: соединение доходит, рукопожатие проходит, мелкие пакеты (DNS) идут,
# а в очереди на отправку ему висят килобайты и не уходят — оператор душит поток. Так вело
# себя Reality и через релей (порт 20019), и напрямую на 443 — то есть дело было НЕ в порту.
# Тот же путь, тот же адрес, но с обычным TLS + WebSocket заработал сразу: 25 Мбит/с по
# Wi-Fi и 144 Мбит/с на мобильном.
#
# Разница принципиальная: Reality ПОДДЕЛЫВАЕТ чужое рукопожатие (притворяется
# addons.mozilla.org, не имея на него прав), и достаточно строгий оператор это ловит.
# Здесь же — свой домен и свой валидный сертификат: снаружи это неотличимо от захода на
# обычный сайт, потому что это и ЕСТЬ обычное TLS-соединение с настоящим сайтом.
set -euo pipefail

SERVER_IP="${1:?Нужен публичный IP сервера первым аргументом}"
DOMAIN="${2:?Нужен домен вторым аргументом (A-запись должна уже указывать на этот сервер)}"
XRAY_CONF_DIR=/usr/local/etc/xray
XRAY_CONF="$XRAY_CONF_DIR/config.json"
CERT_DIR="$XRAY_CONF_DIR/certs"
PORT=443

# >>> distro-lib (одинаковый блок в install-vless-*.sh; сверяет scripts/distro-lib.test.ts)
# Любой серверный Linux с systemd: Debian/Ubuntu и производные (Astra, Mint, Kali…),
# RHEL-семейство (Alma, Rocky, CentOS Stream, RHEL, Oracle, Fedora, Amazon Linux),
# openSUSE/SLES, Arch. Без systemd (Alpine, контейнер без init) Xray-install не работает —
# говорим об этом сразу и понятно, а не падаем в середине.
[ "$(id -u)" = "0" ] || { echo "нужны права root" >&2; exit 1; }
[ -d /run/systemd/system ] || {
  echo "на сервере нет systemd (Alpine или контейнер) — Xray здесь не поставить. Нужен обычный VPS: Ubuntu, Debian, AlmaLinux, Rocky, CentOS, Fedora, openSUSE или Arch." >&2
  exit 1
}
OS_ID="unknown"; OS_LIKE=""
if [ -r /etc/os-release ]; then OS_ID="$(. /etc/os-release; echo "${ID:-unknown}")"; OS_LIKE="$(. /etc/os-release; echo "${ID_LIKE:-}")"; fi

# Менеджер пакетов определяем по тому, что реально есть, а не по имени дистрибутива:
# так работают и неизвестные производные.
if   command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf     >/dev/null 2>&1; then PM=dnf
elif command -v yum     >/dev/null 2>&1; then PM=yum
elif command -v zypper  >/dev/null 2>&1; then PM=zypper
elif command -v pacman  >/dev/null 2>&1; then PM=pacman
else echo "не нашёл менеджер пакетов (apt/dnf/yum/zypper/pacman) — система $OS_ID не поддерживается" >&2; exit 1
fi
echo "система: $OS_ID, менеджер пакетов: $PM" >&2
export DEBIAN_FRONTEND=noninteractive

# Свежий VPS первые минуты занят фоновым обновлением (apt: unattended-upgrades держит
# dpkg-lock; dnf/yum: dnf-automatic/packagekit; zypper: zypp.pid).
wait_for_pm() {
  local waited=0 max=600
  while :; do
    case "$PM" in
      apt)
        if command -v fuser >/dev/null 2>&1; then
          fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || break
        else
          pgrep -f 'unattended-upgrade|apt-get|/usr/bin/dpkg' >/dev/null 2>&1 || break
        fi ;;
      dnf|yum) pgrep -x 'dnf|yum|packagekitd' >/dev/null 2>&1 || break ;;
      zypper)  [ -e /run/zypp.pid ] && kill -0 "$(cat /run/zypp.pid 2>/dev/null)" 2>/dev/null || break ;;
      *) break ;;
    esac
    if [ "$waited" -ge "$max" ]; then
      echo "менеджер пакетов занят другим процессом дольше ${max}с — подожди 5-10 минут и запусти снова." >&2
      exit 1
    fi
    echo "менеджер пакетов занят фоновым обновлением системы, жду… (${waited}с)" >&2
    sleep 10
    waited=$((waited + 10))
  done
}

# pm_install <пакеты…> — имена пакетов одинаковые во всех семействах для того, что нам нужно.
pm_install() {
  wait_for_pm
  case "$PM" in
    apt)    apt-get update -y >/dev/null && apt-get install -y "$@" >/dev/null ;;
    dnf)    dnf install -y "$@" >/dev/null ;;
    yum)    yum install -y "$@" >/dev/null ;;
    zypper) zypper --non-interactive install "$@" >/dev/null ;;
    pacman) pacman -Sy --noconfirm --needed "$@" >/dev/null ;;
  esac
}
need_cmd() { # need_cmd <команда> [пакет]
  command -v "$1" >/dev/null 2>&1 || pm_install "${2:-$1}"
}
# certbot в RHEL-семействе живёт в EPEL (в Fedora и остальных — в основных репозиториях).
install_certbot() {
  command -v certbot >/dev/null 2>&1 && return 0
  case "$PM" in
    dnf|yum) pm_install certbot || { pm_install epel-release && pm_install certbot; } ;;
    *)       pm_install certbot ;;
  esac
}
# Открыть порт в том файрволе, который на сервере реально есть (ufw / firewalld).
open_port() { # open_port <порт>/tcp
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "$1" comment 'vpn-stanok' >/dev/null 2>&1 || true
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$1" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}
new_uuid() { cat /proc/sys/kernel/random/uuid; }
# <<< distro-lib

need_cmd curl
need_cmd jq
need_cmd openssl

if ! command -v xray >/dev/null 2>&1; then
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi

mkdir -p "$XRAY_CONF_DIR" "$CERT_DIR"

# Повторный запуск на уже настроенном узле: ничего не пересоздаём (иначе порвём выданные
# клиентам ссылки), только поднимаем сервис и отдаём ту же ссылку.
if [ -s "$XRAY_CONF" ] && jq -e '.inbounds[] | select(.tag=="ws-tls-in")' "$XRAY_CONF" >/dev/null 2>&1; then
  systemctl enable xray >/dev/null 2>&1 || true
  systemctl restart xray
  FIRST_UUID="$(jq -r '.inbounds[] | select(.tag=="ws-tls-in") | .settings.clients[0].id' "$XRAY_CONF")"
  WS_PATH="$(jq -r '.inbounds[] | select(.tag=="ws-tls-in") | .streamSettings.wsSettings.path' "$XRAY_CONF")"
  LINK="vless://${FIRST_UUID}@${DOMAIN}:${PORT}?type=ws&security=tls&sni=${DOMAIN}&host=${DOMAIN}&path=${WS_PATH//\//%2F}&encryption=none#${DOMAIN}"
  echo "###CLIENT_CONFIG_START###"
  echo "$LINK"
  echo "###CLIENT_CONFIG_END###"
  exit 0
fi

# --- Сертификат ---
# Домен обязан уже указывать на этот сервер, иначе Let's Encrypt не подтвердит владение.
# Ждём распространения DNS, а не падаем сразу: запись создаётся станком прямо перед
# запуском этого скрипта, и пара минут на её разлёт — нормально.
echo "жду, пока $DOMAIN начнёт резолвиться в $SERVER_IP…" >&2
resolved=""
for _ in $(seq 1 30); do
  resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
  [ "$resolved" = "$SERVER_IP" ] && break
  sleep 10
done
if [ "$resolved" != "$SERVER_IP" ]; then
  echo "домен $DOMAIN не указывает на $SERVER_IP (сейчас: ${resolved:-нет ответа}) — сертификат не получить" >&2
  exit 1
fi

install_certbot
open_port 80/tcp
open_port "${PORT}/tcp"
# Порт 80 нужен только на время проверки владения доменом.
certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN" >/dev/null 2>&1 || {
  echo "не удалось получить сертификат для $DOMAIN (порт 80 занят или домен не доехал)" >&2
  exit 1
}

# 🔴 Ловушка, пойманная живьём 08.09 на узле #19: xray работает под пользователем `nobody`,
# а /etc/letsencrypt/{live,archive} имеют права 0700 root — процесс не может прочитать
# сертификат и падает с "permission denied", утаскивая за собой ВЕСЬ инбаунд. Поэтому
# кладём копию туда, где её видит сам xray, и обновляем её при каждом продлении.
# Пользователь, от которого реально работает xray: свежий установщик ставит `xray`, старый — `nobody`.
# 19.10 на узле #35 ключ остался за nobody, сервис шёл от xray → permission denied.
# Группа `nogroup` есть только в Debian-семействе, поэтому берём группу самого пользователя.
xray_owner() {
  u="$(systemctl show -p User --value xray 2>/dev/null)"; [ -n "$u" ] || u=nobody
  g="$(systemctl show -p Group --value xray 2>/dev/null)"; [ -n "$g" ] || g="$(id -gn "$u" 2>/dev/null || echo nobody)"
  echo "$u:$g"
}
install_certs() {
  OWN="$(xray_owner)"
  install -m 644 -o "${OWN%%:*}" -g "${OWN##*:}" "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/fullchain.pem"
  install -m 600 -o "${OWN%%:*}" -g "${OWN##*:}" "/etc/letsencrypt/live/$DOMAIN/privkey.pem"  "$CERT_DIR/privkey.pem"
}
install_certs

# Без этого сертификат молча протухнет через 90 дней и узел встанет.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/xray-certs.sh <<HOOK
#!/bin/sh
U=\$(systemctl show -p User --value xray); [ -n "\$U" ] || U=nobody; G=\$(id -gn "\$U")
install -m 644 -o \$U -g \$G /etc/letsencrypt/live/$DOMAIN/fullchain.pem $CERT_DIR/fullchain.pem
install -m 600 -o \$U -g \$G /etc/letsencrypt/live/$DOMAIN/privkey.pem  $CERT_DIR/privkey.pem
systemctl restart xray
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/xray-certs.sh

# --- Конфиг ---
FIRST_UUID="$(new_uuid)"
# Путь случайный, а не общий /ws: по одинаковому пути у всех узлов сеть операторов
# со временем научится узнавать нас оптом.
WS_PATH="/$(openssl rand -hex 6)"

jq -n \
  --arg uuid "$FIRST_UUID" --arg domain "$DOMAIN" --arg wspath "$WS_PATH" \
  --arg cert "$CERT_DIR/fullchain.pem" --arg key "$CERT_DIR/privkey.pem" \
  --argjson port "$PORT" \
  '{
    log: { loglevel: "warning" },
    api: { tag: "api", listen: "127.0.0.1:10085", services: ["HandlerService", "StatsService"] },
    stats: {},
    policy: { levels: { "0": { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      {
        tag: "ws-tls-in",
        listen: "0.0.0.0", port: $port, protocol: "vless",
        settings: {
          clients: [{ id: $uuid, email: "owner" }],
          decryption: "none"
        },
        streamSettings: {
          network: "ws", security: "tls",
          tlsSettings: {
            serverName: $domain,
            alpn: ["http/1.1"],
            certificates: [{ certificateFile: $cert, keyFile: $key }]
          },
          wsSettings: { path: $wspath }
        }
      }
    ],
    dns: { servers: ["1.1.1.1", "8.8.8.8"], queryStrategy: "UseIPv4" },
    outbounds: [
      { tag: "direct", protocol: "freedom", settings: { domainStrategy: "UseIPv4" } },
      { tag: "blocked", protocol: "blackhole" }
    ],
    routing: { rules: [{ type: "field", ip: ["::/0"], outboundTag: "blocked" }] }
  }' > "$XRAY_CONF"

systemctl enable xray >/dev/null 2>&1 || true
systemctl restart xray

# Проверяем, что сервис реально поднялся: без этого узел уезжает в продакшн "установленным",
# а клиенты получают ссылку в никуда (ровно так и вышло 08.09 с правами на сертификат).
sleep 2
if ! systemctl is-active --quiet xray; then
  echo "xray не запустился после установки:" >&2
  journalctl -u xray --no-pager -n 15 >&2 || true
  exit 1
fi

LINK="vless://${FIRST_UUID}@${DOMAIN}:${PORT}?type=ws&security=tls&sni=${DOMAIN}&host=${DOMAIN}&path=${WS_PATH//\//%2F}&encryption=none#${DOMAIN}"

echo "###CLIENT_CONFIG_START###"
echo "$LINK"
echo "###CLIENT_CONFIG_END###"
