#!/usr/bin/env bash
# Read-only для клиентов: отдаёт, сколько трафика прошло по каждому клиенту с прошлого вызова.
# Счётчики Xray читаются с --reset, поэтому каждый вызов = приращение за интервал (бот
# складывает их сам, так счёт переживает перезапуск xray и не зависит от его аптайма).
# Вывод: по строке JSON на клиента {"uuid":"…","up":N,"down":N}. Клиент без трафика не печатается.
set -euo pipefail
command -v jq >/dev/null 2>&1 || { echo "нет jq в системе" >&2; exit 1; }
out="$(xray api statsquery --server=127.0.0.1:10085 -pattern 'user>>>' -reset 2>/dev/null || true)"
[ -n "$out" ] || exit 0
echo "$out" | jq -c '
  [ (.stat // [])[]
    | (.name | split(">>>")) as $p
    | select($p[0] == "user" and $p[2] == "traffic")
    | {uuid: $p[1], dir: $p[3], v: ((.value // 0) | tonumber)} ]
  | group_by(.uuid)[]
  | { uuid: .[0].uuid,
      up:   ([.[] | select(.dir == "uplink")   | .v] | add // 0),
      down: ([.[] | select(.dir == "downlink") | .v] | add // 0) }
  | select(.up > 0 or .down > 0)'
