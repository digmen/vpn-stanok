#!/usr/bin/env bash
# Добавляет нового клиента VLESS+Reality в конфиг Xray. Запускается на сервере от root.
# Печатает ###CLIENT_PUBKEY### (тут это UUID — тем же именем, что и AmneziaWG-пир,
# чтобы vpn.ts мог разбирать вывод обоих протоколов одним и тем же кодом) и
# клиентский конфиг между маркерами — тот же контракт, что у add-amneziawg-peer.sh.
set -euo pipefail

XRAY_CONF=/usr/local/etc/xray/config.json
[ -f "$XRAY_CONF" ] || { echo "нет $XRAY_CONF — VLESS+Reality не установлен (install-vless-reality.sh)" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "нет jq в системе" >&2; exit 1; }

PORT="$(jq -r '.inbounds[0].port' "$XRAY_CONF")"
PBK="$(jq -r '.inbounds[0].streamSettings.realitySettings.publicKey' "$XRAY_CONF")"
SID="$(jq -r '.inbounds[0].streamSettings.realitySettings.shortIds[0]' "$XRAY_CONF")"
DEST_FULL="$(jq -r '.inbounds[0].streamSettings.realitySettings.dest' "$XRAY_CONF")"
DEST="${DEST_FULL%%:*}"

UUID="$(uuidgen)"

jq --arg uuid "$UUID" \
  '.inbounds[0].settings.clients += [{id: $uuid, email: $uuid, flow: "xtls-rprx-vision"}]' \
  "$XRAY_CONF" > "${XRAY_CONF}.tmp"
mv "${XRAY_CONF}.tmp" "$XRAY_CONF"

# Живьём через API Xray, без рестарта — тот же принцип, что и в install-vless.sh
# у Александра: рестарт рвёт сессии ВСЕХ подключённых, а не только нового клиента.
apply_live() {
  local tmp rc
  tmp="$(mktemp)"
  jq -n --arg tag "reality-in" --arg uuid "$UUID" \
    '{inbounds: [{tag: $tag, settings: {clients: [{id: $uuid, flow: "xtls-rprx-vision"}]}}]}' > "$tmp"
  xray api adu --server=127.0.0.1:10085 "$tmp" >/dev/null 2>&1
  rc=$?
  rm -f "$tmp"
  return $rc
}

if ! apply_live; then
  echo "xray api недоступен — применяю перезапуском (сессии оборвутся)" >&2
  systemctl restart xray
fi

# IP — живым определением через curl (тот же порядок приоритетов, что и
# add-amneziawg-peer.sh: свой сервер мог сменить IP без переустановки).
ENDPOINT_HOST="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$ENDPOINT_HOST" ]; then
  echo "не смог определить свой публичный IP (api.ipify.org не ответил) — конфиг будет с плейсхолдером, вызывающий код (withVlessHost) обязан подставить правильный host" >&2
  ENDPOINT_HOST="0.0.0.0"
fi

# Метка (#...) — статичная, не IP: withVlessHost (parse.ts) переписывает адрес
# подключения на актуальный host локации из бота, но метку не трогает (она
# только косметическое имя профиля в приложении клиента) — если положить сюда
# самоопределённый IP, он устареет молча при первой же смене адреса локации.
LINK="vless://${UUID}@${ENDPOINT_HOST}:${PORT}?type=tcp&security=reality&pbk=${PBK}&fp=chrome&sni=${DEST}&sid=${SID}&flow=xtls-rprx-vision#vless-reality"

echo "###CLIENT_PUBKEY###${UUID}"
cat <<EOF
###CLIENT_CONFIG_START###
$LINK
###CLIENT_CONFIG_END###
EOF
