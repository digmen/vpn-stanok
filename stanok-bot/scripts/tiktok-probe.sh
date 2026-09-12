#!/usr/bin/env bash
# Разовая диагностика: отвечает ли TikTok этому IP. Запускается НА сервере, чей выходной
# адрес проверяем, — так видно, режет ли TikTok сам IP, без клиента и туннеля посередине.
# Ничего не ставит и не меняет.
UA='Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
for url in \
  https://www.tiktok.com/ \
  https://m.tiktok.com/ \
  https://www.tiktok.com/api/recommend/item_list/ \
  https://api16-normal-c-useast1a.tiktokv.com/ \
  https://api22-normal-c-useast2a.tiktokv.com/ \
  https://log16-normal-c-useast1a.tiktokv.com/ \
  https://mon.tiktokv.com/ \
  https://sf16-website-login.neutral.ttwstatic.com/ \
  https://p16-sign-va.tiktokcdn.com/ \
  https://v16-webapp-prime.tiktok.com/ \
  https://www.google.com/generate_204; do
  printf '%-58s ' "$url"
  curl -4 -s -o /tmp/tt.body -A "$UA" -m 12 \
    -w 'код %{http_code}  tls %{time_appconnect}s  всего %{time_total}s  ip %{remote_ip}' "$url" 2>&1 || printf 'ОШИБКА curl %s' "$?"
  # Признаки блокировки по региону/IP в теле ответа
  if grep -qiE 'not available in your|access denied|region|blocked|captcha' /tmp/tt.body 2>/dev/null; then
    printf '  ⚠ в ответе: %s' "$(grep -oiE 'not available in your [a-z ]+|access denied|captcha|blocked' /tmp/tt.body | head -1)"
  fi
  echo
done
rm -f /tmp/tt.body
echo "--- IPv6 у сервера: $(ip -6 route show default 2>/dev/null | head -1 || true)"
echo "--- AAAA для www.tiktok.com: $(getent ahostsv6 www.tiktok.com 2>/dev/null | head -1 | awk '{print $1}')"
