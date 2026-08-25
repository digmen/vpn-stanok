// Точка входа ДЛЯ СТАНКА (не для владельца напрямую): добавляет доп. локацию в
// ЭТОТ бот-продавец без диалога с владельцем — используется, когда он заводит
// ещё один сервер через станок, а не через самого себя (attach-location.ts на
// стороне станка). Приватный ключ приходит уже готовым файлом, пароль от нового
// сервера сюда вообще не попадает — станок его не пересылает.
//
// usage: tsx cli-add-location.ts <host> <port|''> <keyFilePath> [title]
import { readFileSync } from 'node:fs';
import { addRemote, nextLocationId, saveKey } from '../src/locations.js';

const [host, portArg, keyFilePath, title] = process.argv.slice(2);
if (!host || !keyFilePath) {
  console.error('usage: cli-add-location.ts <host> <port|""> <keyFilePath> [title]');
  process.exit(1);
}
const port = portArg ? Number(portArg) : undefined;
const privateKey = readFileSync(keyFilePath, 'utf8');

const id = nextLocationId();
const keyFile = `loc-${id}.key`;
saveKey(keyFile, privateKey);
addRemote({ id, title: (title || host).slice(0, 24), host, ...(port ? { port } : {}), user: 'root', keyFile });

// Последняя строка — то, что читает station (attach-location.ts берёт последнюю строку stdout).
console.log(JSON.stringify({ id }));
