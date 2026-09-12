#!/usr/bin/env python3
"""Разбор журнала xray по ОДНОМУ ключу (владельца): куда ходит, именами или адресами, по
TCP или UDP. Запускается на узле, получает на вход journalctl, печатает только сводку.
Нужен, чтобы понять, чем путь одного конкретного телефона отличается от остальных."""
import re, sys, collections

own = sys.argv[1]
pat = re.compile(r'accepted (tcp|udp):(\S+?):(\d+) \[ws-tls-in (?:>>|->) (\w+)\] email: (\S+)')
tt = re.compile(r'tiktok|ibyte|byteoversea|ttwstatic|musical|bytedance', re.I)

by_user = collections.Counter()
by_user_ip = collections.Counter()
own_proto = collections.Counter()
own_ip_dest = collections.Counter()
own_domains = collections.Counter()
own_route = collections.Counter()
total_own = 0
for line in sys.stdin:
    m = pat.search(line)
    if not m:
        continue
    proto, host, port, route, user = m.groups()
    is_ip = bool(re.fullmatch(r'[\d.]+|\[.*\]', host))
    if tt.search(host):
        by_user[user[:8]] += 1
    by_user_ip[(user[:8], is_ip)] += 1
    if user == own:
        total_own += 1
        own_proto[proto] += 1
        own_route[route] += 1
        if is_ip:
            own_ip_dest[(proto, host, port)] += 1
        else:
            own_domains[host] += 1

print('--- кто ходит в TikTok ИМЕНАМИ (соединений за 48 ч, первые 8 символов ключа)')
for u, c in by_user.most_common(8):
    print(f'  {u}  {c}' + ('   ← владелец' if own.startswith(u) else ''))
print('--- как клиенты задают адрес: доля «готовых IP» вместо имён')
users = {u for u, _ in by_user_ip}
for u in sorted(users, key=lambda x: -(by_user_ip[(x, True)] + by_user_ip[(x, False)]))[:8]:
    ip, dn = by_user_ip[(u, True)], by_user_ip[(u, False)]
    print(f'  {u}  IP {ip:6}  имён {dn:6}  → {round(100 * ip / max(1, ip + dn))}% IP' + ('   ← владелец' if own.startswith(u) else ''))
print(f'--- владелец: всего {total_own}; протоколы {dict(own_proto)}; маршрут {dict(own_route)}')
print('--- владелец: самые частые назначения-IP')
for (p, h, port), c in own_ip_dest.most_common(15):
    print(f'  {c:6}  {p}:{h}:{port}')
print('--- владелец: самые частые имена')
for h, c in own_domains.most_common(10):
    print(f'  {c:6}  {h}')
