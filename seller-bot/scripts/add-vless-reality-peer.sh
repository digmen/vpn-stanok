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
#
# 🔴 06.09, живой баг на первом же реальном прогоне: InboundDetour для `adu`
# обязан нести `listen`/`port`/`protocol`, не только `tag`+`settings` — без них
# `xray api adu` падает с "Listen on AnyIP but no Port(s) set in InboundDetour"
# И ПРИ ЭТОМ ВЫХОДИТ С КОДОМ 0 (!), просто печатая "Added 0 user(s) in total" —
# apply_live() считала это успехом, файл конфига обновлялся, а живой процесс —
# нет, и следующий клиент получал "invalid request user id" при реальном
# подключении. Взят рабочий паттерн Александра (add-vless-client.sh): тянуть
# listen/port/protocol из САМОГО конфига через jq select, не собирать вручную.
# Плюс не верим exit-коду — парсим "Added N user(s)", 0 считаем провалом.
apply_live() {
  local tmp out added
  tmp="$(mktemp)"
  jq --arg uuid "$UUID" \
    '{inbounds: [ .inbounds[] | select(.protocol == "vless") | {tag, listen, port, protocol, settings: {clients: [{id: $uuid, flow: "xtls-rprx-vision"}], decryption: "none"}} ]}' \
    "$XRAY_CONF" > "$tmp"
  out="$(xray api adu --server=127.0.0.1:10085 "$tmp" 2>&1)"
  rm -f "$tmp"
  added="$(echo "$out" | grep -oE 'Added [0-9]+ user' | grep -oE '[0-9]+' || echo 0)"
  [ "$added" -gt 0 ]
}

if ! apply_live; then
  # 06.09, живой прогон: даже с полным InboundDetour (tag+listen+port+protocol+
  # settings, ровно как у Александра) `adu` стабильно печатает "Added 0 user(s)"
  # на Reality-инбаунде конкретно — без ошибки, без диагностики. `rmu` (отзыв)
  # при этом работает живьём нормально, разницы в форме вызова нет. Похоже на
  # ограничение самого Xray/Reality (внутреннее состояние подмены сертификата
  # у Reality может не поддерживать горячее добавление клиента так же, как
  # обычный TLS/WS-инбаунд, для которого этот приём и был взят у Александра) —
  # не подтверждено окончательно, но воспроизведено дважды подряд. Рестарт —
  # рабочий путь, просто не бесплатный (рвёт сессии остальных подключённых);
  # если найдётся настоящая причина — почистить этот комментарий и убрать fallback.
  echo "xray api не добавил клиента живьём (известное ограничение Reality-инбаунда, см. комментарий) — применяю перезапуском" >&2
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
