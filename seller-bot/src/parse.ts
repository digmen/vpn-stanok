import { CONFIG_MARKERS } from './constants.js';

const CONFIG_RE = new RegExp(`${CONFIG_MARKERS.START}\\s*([\\s\\S]*?)\\s*${CONFIG_MARKERS.END}`);

// Достаёт клиентский VPN-конфиг из вывода add-peer скрипта (между маркерами).
export function extractClientConfig(stdout: string): string | null {
  const m = stdout.match(CONFIG_RE);
  return m ? m[1].trim() : null;
}

/**
 * Перезаписывает host в строке `Endpoint = host:port` конфига на заданный,
 * сохраняя порт.
 *
 * 🔴 Общий фикс бага 25.08 (а не симптома). Endpoint приходит с сервера из
 * `SERVER_PUB_IP`, зашитого при установке AmneziaWG. Если IP узла потом сменился
 * (у этих VPS это норма), все выданные конфиги тихо указывают на СТАРЫЙ адрес и
 * не подключаются — а лечилось это только руками в `params` на сервере, о чём
 * узнавали лишь по жалобе клиента. Источник правды по адресу должен быть там,
 * где владелец им управляет и может поменять, — это host локации в боте.
 * Поэтому Endpoint приводим к нему принудительно: сменил IP в боте → все новые
 * конфиги сразу верные, без захода на сервер.
 *
 * `[^\s:]+` не матчит IPv6 (там двоеточия в host) — на таком формате строка не
 * трогается; и если Endpoint вовсе не нашёлся, возвращаем конфиг как есть, не
 * ломая выдачу.
 */
export function withEndpointHost(config: string, host: string): string {
  return config.replace(/^(Endpoint\s*=\s*)[^\s:]+(:\d+)\s*$/im, `$1${host}$2`);
}
