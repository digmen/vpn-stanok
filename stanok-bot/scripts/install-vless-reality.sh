#!/usr/bin/env bash
# Ставит VLESS+Reality БЕЗ домена: Xray-core, один инбаунд на 443, маскировка под
# чужой реальный TLS-хендшейк (Reality ворует сертификат/почерк addons.mozilla.org,
# не свой домен и не свой сертификат). Usage: install-vless-reality.sh <SERVER_PUBLIC_IP>
#
# Перенесено с пражского стенда (проверено живым трафиком 31.08, см. Проекты/
# VLESS-Александр/00 - Журнал проекта.md) — не новая идея, а обобщение того, что
# уже работало на одном конкретном сервере, под произвольный узел станка.
#
# 🔴 Честная граница метода (важно понимать, не только запускать):
# Reality переживает обычный DPI (блокировку по сигнатуре протокола) — это
# подтверждено. Reality НЕ переживает белый список (когда разрешён только заранее
# одобренный список адресов, весь остальной трафик режется по умолчанию) — сервер
# маскирует, ЧТО это за трафик, а не КУДА он идёт, и это было эмпирически
# проверено и провалилось на реальном мобильном ТСПУ у Александра (01-02.09,
# «Reality(Москва)→WS(Лондон) не пережил мобильную глушку»). Если исходная задача —
# пережить именно белый список, этот протокол её не решает лучше AmneziaWG.
# Если задача — пережить обычную DPI-блокировку (или обойти блок UDP целиком,
# которого AmneziaWG не переживает, а этот протокол — TCP:443 — переживает),
# это рабочий вариант.
set -euo pipefail

SERVER_IP="${1:?Нужен публичный IP сервера первым аргументом}"
XRAY_CONF_DIR=/usr/local/etc/xray
XRAY_CONF="$XRAY_CONF_DIR/config.json"
REALITY_PORT=443
# addons.mozilla.org — единственный dest, подтверждённый рабочим на живом тесте
# (31.08). www.microsoft.com пробовали первым — стабильно проваливал хендшейк
# ("processed invalid connection"), несмотря на побитово совпадающие ключи —
# причина не выяснена (что-то в поведении microsoft-эджа), просто не тратить
# время на него снова.
DEST="addons.mozilla.org"

export DEBIAN_FRONTEND=noninteractive

# Та же грабля, что и в install-amneziawg.sh: свежий VPS первые минуты держит
# dpkg-lock под unattended-upgrades.
wait_for_apt() {
  local waited=0 max=600
  while :; do
    if command -v fuser >/dev/null 2>&1; then
      fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || break
    else
      pgrep -f 'unattended-upgrade|apt-get|/usr/bin/dpkg' >/dev/null 2>&1 || break
    fi
    if [ "$waited" -ge "$max" ]; then
      echo "apt/dpkg занят другим процессом дольше ${max}с — подожди 5-10 минут и запусти снова." >&2
      exit 1
    fi
    echo "apt занят фоновым обновлением системы, жду… (${waited}с)" >&2
    sleep 10
    waited=$((waited + 10))
  done
}

wait_for_apt
command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y curl >/dev/null; }
command -v jq >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y jq uuid-runtime >/dev/null; }

# --- Xray-core (идемпотентно) ---
if ! command -v xray >/dev/null 2>&1; then
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi

mkdir -p "$XRAY_CONF_DIR"

# Уже установлен и настроен (переустановка того же узла, IP не менялся в смысле
# конфига — сам конфиг Reality от IP не зависит вообще, в отличие от AmneziaWG) —
# ничего не генерируем заново, просто убеждаемся, что сервис поднят.
if [ -s "$XRAY_CONF" ] && jq -e '.inbounds[0].streamSettings.realitySettings.privateKey' "$XRAY_CONF" >/dev/null 2>&1; then
  systemctl enable xray >/dev/null 2>&1 || true
  systemctl restart xray
  FIRST_UUID="$(jq -r '.inbounds[0].settings.clients[0].id' "$XRAY_CONF")"
  PBK="$(jq -r '.inbounds[0].streamSettings.realitySettings.publicKey // empty' "$XRAY_CONF")"
  SID="$(jq -r '.inbounds[0].streamSettings.realitySettings.shortIds[0]' "$XRAY_CONF")"
  if [ -z "$PBK" ]; then
    echo "нет сохранённого публичного ключа (старая установка без него) — пересоздай узел" >&2
    exit 1
  fi
  LINK="vless://${FIRST_UUID}@${SERVER_IP}:${REALITY_PORT}?type=tcp&security=reality&pbk=${PBK}&fp=chrome&sni=${DEST}&sid=${SID}&flow=xtls-rprx-vision#${SERVER_IP}"
  echo "###CLIENT_CONFIG_START###"
  echo "$LINK"
  echo "###CLIENT_CONFIG_END###"
  exit 0
fi

# --- Генерация ключей ---
# `xray x25519` печатает разными версиями Xray под разными подписями. Живьём на
# 26.3.27 (06.09) формат оказался:
#   PrivateKey: xxx
#   Password (PublicKey): xxx
#   Hash32: xxx
# — публичный ключ не сразу после "Password"/"Public key" через двоеточие
# (как ожидалось изначально), а через "Password (PublicKey): xxx". Первая
# версия regexp это не поймала (падала в тихий exit 1 на первом же реальном
# прогоне) — теперь матчим по началу строки без требования, что сразу за
# словом идёт двоеточие, только что колонка "password"/"public" где-то есть.
KEYGEN_OUT="$(xray x25519)"
PRIVATE_KEY="$(echo "$KEYGEN_OUT" | grep -iE '^(private ?key)' | head -1 | sed -E 's/^[^:]+:\s*//')"
PUBLIC_KEY="$(echo "$KEYGEN_OUT" | grep -iE '^(password|public ?key)' | head -1 | sed -E 's/^[^:]+:\s*//')"
if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ]; then
  echo "не смог распарсить вывод xray x25519:" >&2
  echo "$KEYGEN_OUT" >&2
  exit 1
fi

SHORT_ID="$(openssl rand -hex 8)"
FIRST_UUID="$(uuidgen)"

# Инбаунд с тегом (нужен теге для xray api adu/rmu — живая выдача/отзыв клиентов
# без рестарта, тот же подход, что и в install-vless.sh у Александра) + сразу
# сохраняем publicKey рядом с privateKey — обычно в конфиг Reality публичный ключ
# не кладут (клиенту не нужен на сервере), но он нужен НАМ при переустановке/
# повторном запуске скрипта, чтобы не генерить новую пару и не рвать выданные
# клиентам ссылки. Xray сам это поле игнорирует, ошибкой не считает.
jq -n \
  --arg uuid "$FIRST_UUID" --arg priv "$PRIVATE_KEY" --arg pub "$PUBLIC_KEY" \
  --arg sid "$SHORT_ID" --arg dest "$DEST" --argjson port "$REALITY_PORT" \
  '{
    log: { loglevel: "warning" },
    api: { tag: "api", listen: "127.0.0.1:10085", services: ["HandlerService", "StatsService"] },
    stats: {},
    policy: { levels: { "0": { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      {
        tag: "reality-in",
        listen: "0.0.0.0", port: $port, protocol: "vless",
        settings: {
          clients: [{ id: $uuid, email: "owner", flow: "xtls-rprx-vision" }],
          decryption: "none"
        },
        streamSettings: {
          network: "tcp", security: "reality",
          realitySettings: {
            show: false, dest: ($dest + ":443"), xver: 0,
            serverNames: [$dest],
            privateKey: $priv, publicKey: $pub,
            shortIds: [$sid]
          }
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

# --- firewall ---
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${REALITY_PORT}/tcp" comment 'vless-reality' >/dev/null 2>&1 || true
fi

LINK="vless://${FIRST_UUID}@${SERVER_IP}:${REALITY_PORT}?type=tcp&security=reality&pbk=${PUBLIC_KEY}&fp=chrome&sni=${DEST}&sid=${SHORT_ID}&flow=xtls-rprx-vision#${SERVER_IP}"

echo "###CLIENT_CONFIG_START###"
echo "$LINK"
echo "###CLIENT_CONFIG_END###"
