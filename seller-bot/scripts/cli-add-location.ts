// Точка входа ДЛЯ СТАНКА (не для владельца напрямую): добавляет доп. локацию в
// ЭТОТ бот-продавец без диалога с владельцем — используется, когда он заводит
// ещё один сервер через станок, а не через самого себя (attach-location.ts на
// стороне станка). Приватный ключ приходит уже готовым файлом, пароль от нового
// сервера сюда вообще не попадает — станок его не пересылает.
//
// usage: tsx cli-add-location.ts <host> <port|''> <keyFilePath> [title] [protocol]
import { readFileSync } from 'node:fs';
import { addRemote, nextLocationId, saveKey, type VpnProtocol } from '../src/locations.js';

const [host, portArg, keyFilePath, title, protocolArg] = process.argv.slice(2);
if (!host || !keyFilePath) {
  console.error('usage: cli-add-location.ts <host> <port|""> <keyFilePath> [title] [protocol]');
  process.exit(1);
}
const port = portArg ? Number(portArg) : undefined;
const privateKey = readFileSync(keyFilePath, 'utf8');
// Отсутствует у старых вызовов станка (до 05.09) — amneziawg, там ничего другого не ставили.
const protocol: VpnProtocol = protocolArg === 'vless_reality' ? 'vless_reality' : 'amneziawg';

const id = nextLocationId();
const keyFile = `loc-${id}.key`;
saveKey(keyFile, privateKey);
addRemote({ id, title: (title || host).slice(0, 24), host, ...(port ? { port } : {}), user: 'root', keyFile, protocol });

// Последняя строка — то, что читает station (attach-location.ts берёт последнюю строку stdout).
console.log(JSON.stringify({ id }));
