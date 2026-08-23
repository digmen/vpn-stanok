#!/usr/bin/env bash
# Ставит AmneziaWG через установщик wiresock (headless) и выдаёт конфиг автосозданного клиента.
# Usage: install-amneziawg.sh <SERVER_PUBLIC_IP>
set -euo pipefail

SERVER_IP="${1:?Нужен публичный IP сервера первым аргументом}"
INSTALLER=/root/amneziawg-install.sh

export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null && apt-get install -y curl >/dev/null; }

if [ ! -x "$INSTALLER" ]; then
  curl -fsSL -o "$INSTALLER" \
    https://raw.githubusercontent.com/wiresock/amneziawg-install/main/amneziawg-install.sh
  chmod +x "$INSTALLER"
fi

# Апстрим-установщик узнаёт ОС буквальным сравнением ID из /etc/os-release
# со своим списком (debian/ubuntu/linuxmint/fedora/centos/almalinux/rocky) —
# любой другой Debian-производной дистрибутив падает с "not a supported
# system", даже если под капотом это тот же apt/systemd/ядро. Столкнулись
# 23.08 на живом узле клиента: Astra Linux 1.8 — ID=astra, ID_LIKE=debian,
# фактически Debian 11 (apt-get есть, ядро debian-патченное), но в списке
# апстрима её, конечно, нет и не будет (это не Ubuntu/Debian, отдельная сборка
# под гос-заказчиков РФ). Та же ситуация будет у любого будущего клиента на
# Kali/Devuan/MX Linux/другой Debian-производной — не только у Astra,
# поэтому проверка ниже общая (по ID_LIKE), а не хардкод под один дистрибутив.
#
# Правим не сам сервер клиента навсегда, а ТОЛЬКО на время работы
# installer'а: подменяем /etc/os-release на "как будто Debian 11" (проверка
# апстрима смотрит только на ID/VERSION_ID, остального не касается), запускаем
# установку, возвращаем оригинал обратно — trap гарантирует восстановление
# даже если сама установка упадёт с ошибкой на середине.
OS_RELEASE=/etc/os-release
OS_RELEASE_BACKUP=""
if [ -r "$OS_RELEASE" ]; then
  . "$OS_RELEASE"
  case " ${ID:-} " in
    " debian "|" raspbian "|" ubuntu "|" linuxmint "|" fedora "|" centos "|" almalinux "|" rocky ")
      : # уже в списке апстрима — трогать нечего
      ;;
    *)
      case " ${ID_LIKE:-} " in
        *debian*)
          echo "ОС ${PRETTY_NAME:-$ID} апстрим не узнаёт по имени, но она Debian-производная (ID_LIKE=debian) — подменяю на время установки" >&2
          OS_RELEASE_BACKUP="$(mktemp)"
          cp "$OS_RELEASE" "$OS_RELEASE_BACKUP"
          trap 'cp "$OS_RELEASE_BACKUP" "$OS_RELEASE"; rm -f "$OS_RELEASE_BACKUP"' EXIT
          # VERSION_ID=11 — минимальная версия, которую примет проверка
          # апстрима (>=11), не настоящий номер версии Astra/другого дистрибутива.
          printf 'ID=debian\nID_LIKE=debian\nVERSION_ID="11"\nPRETTY_NAME="%s (detected as Debian 11 for installer)"\n' \
            "${PRETTY_NAME:-$ID}" > "$OS_RELEASE"
          ;;
      esac
      ;;
  esac
fi

# Установка (idempotent). AUTO_INSTALL создаёт сервер и первого клиента.
if ! command -v awg >/dev/null 2>&1; then
  AUTO_INSTALL=y SERVER_PUB_IP="$SERVER_IP" bash "$INSTALLER"
fi

# Оригинал /etc/os-release возвращён либо тут (успех), либо в trap (ошибка) —
# делаем это сразу после установки, а не только в конце скрипта: дальше по
# коду ничего от os-release не зависит, и лучше вернуть систему в исходное
# состояние как можно раньше, а не держать её подменённой дольше необходимого.
if [ -n "$OS_RELEASE_BACKUP" ]; then
  cp "$OS_RELEASE_BACKUP" "$OS_RELEASE"
  rm -f "$OS_RELEASE_BACKUP"
  trap - EXIT
fi

# Владельцу отдаём конфиг автосозданного клиента
CONF="$(ls -1 /root/awg0-client-*.conf 2>/dev/null | head -1 || true)"
[ -n "$CONF" ] && [ -f "$CONF" ] || { echo "конфиг клиента не найден после установки" >&2; exit 1; }

echo "###CLIENT_CONFIG_START###"
cat "$CONF"
echo "###CLIENT_CONFIG_END###"
