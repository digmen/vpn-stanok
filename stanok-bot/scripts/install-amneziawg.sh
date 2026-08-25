#!/usr/bin/env bash
# Ставит AmneziaWG через установщик wiresock (headless) и выдаёт конфиг автосозданного клиента.
# Usage: install-amneziawg.sh <SERVER_PUBLIC_IP>
set -euo pipefail

SERVER_IP="${1:?Нужен публичный IP сервера первым аргументом}"
INSTALLER=/root/amneziawg-install.sh

export DEBIAN_FRONTEND=noninteractive

# Свежий VPS почти всегда занят unattended-upgrades первые минуты после старта:
# он держит dpkg-lock, и любой наш apt падает с "Unable to acquire the dpkg
# frontend lock". Это НЕ ошибка сервера — фоновый апдейт надо переждать, а не
# ронять провижининг (грабля из чек-листа server-bringup). Реальный случай:
# узел #8 (45.148.116.120) упал ровно на этом 24.08. Ждём до 10 минут, потом
# честно объясняем человеку, а не отдаём криптическое сообщение apt.
wait_for_apt() {
  local waited=0 max=600
  while :; do
    if command -v fuser >/dev/null 2>&1; then
      fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || break
    else
      pgrep -f 'unattended-upgrade|apt-get|/usr/bin/dpkg' >/dev/null 2>&1 || break
    fi
    if [ "$waited" -ge "$max" ]; then
      echo "apt/dpkg занят другим процессом (скорее всего unattended-upgrades) дольше ${max}с — сервер только создан и ещё доустанавливает обновления. Подожди 5-10 минут и запусти установку снова." >&2
      exit 1
    fi
    echo "apt занят фоновым обновлением системы, жду… (${waited}с)" >&2
    sleep 10
    waited=$((waited + 10))
  done
}

wait_for_apt
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
# Апстрим-установщик сам делает apt — ещё раз убеждаемся, что lock свободен
# (фоновый апдейт мог стартовать в окне между первой проверкой и этим местом).
if ! command -v awg >/dev/null 2>&1; then
  wait_for_apt
  # 🔴 26.08: порт 443 вместо случайного (апстрим по умолчанию берёт 49152–65535).
  # Повод — живой узел в РФ не мог подключиться на случайном высоком UDP-порту, а на
  # 443 заработало. Не 100% гарантия (мобильные операторы РФ фильтруют и по структуре
  # пакетов, не только по порту — AmneziaWG обфускацию для этого и делает), но 443
  # реже режут не глядя, чем нестандартный high-port. Апстрим-установщик уважает
  # заранее заданный SERVER_PORT, если он есть (не перезаписывает случайным).
  AUTO_INSTALL=y SERVER_PUB_IP="$SERVER_IP" SERVER_PORT=443 bash "$INSTALLER"
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

# 🔴 26.08, второй заход того же дня: установка выше идемпотентна (`command -v awg`) —
# если на диске уже стоит AmneziaWG (тот же VPS, которому просто сменили IP без
# переустановки ОС), апстрим-установщик молча пропускает весь блок и отдаёт СТАРЫЙ
# $CONF, написанный при самой первой установке под прежний IP. Ровно тот же баг,
# что вчера чинили в add-amneziawg-peer.sh, только на уровне первого провижининга —
# тот скрипт этот путь не проверяет вообще, у него свой файл конфига.
# Поймано на живом узле Александра: смена IP через OneDash (150.251.145.250 →
# 91.108.248.151) без переустановки ОС, handshake-проверка проваливалась ПОСЛЕ
# фикса add-peer — потому что провал был не в нём. Лечим тем же способом: не верим
# файлу, принудительно прописываем Endpoint из аргумента (тот IP, что реально в базе
# станка) и живого порта сервера, независимо от того, свежая это установка или нет.
LISTEN_PORT="$(awk -F' *= *' '$1=="ListenPort"{print $2; exit}' /etc/amnezia/amneziawg/awg0.conf 2>/dev/null || true)"
if [ -n "$LISTEN_PORT" ]; then
  sed -i -E "s/^Endpoint = .*/Endpoint = ${SERVER_IP}:${LISTEN_PORT}/" "$CONF"
fi

echo "###CLIENT_CONFIG_START###"
cat "$CONF"
echo "###CLIENT_CONFIG_END###"
