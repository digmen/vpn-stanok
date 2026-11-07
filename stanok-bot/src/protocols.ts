import { InlineKeyboard } from 'grammy';
import type { NodeProtocol } from './db.js';

/**
 * Выбор протокола при создании узла и при добавлении сервера.
 *
 * Выбор вернули 07.11 по просьбе автора франшизы (раньше, с 08.09, ставился только WS+TLS).
 * По умолчанию остаётся WS+TLS: он единственный прошёл проверку у строгого оператора
 * (узел #19, Грозный) — Reality там душили, см. журнал 08.09. Остальные два — честный
 * выбор владельца, а не скрытая замена: описание на кнопке говорит, в чём подвох.
 */

export const PROTOCOL_CALLBACK_PREFIX = 'proto:';
export const DEFAULT_PROTOCOL: NodeProtocol = 'vless_ws_tls';

interface ProtocolInfo {
  id: NodeProtocol;
  /** Подпись на кнопке. */
  button: string;
  /** Строка в тексте вопроса. */
  line: string;
  /** Приложение, которое будет ставить клиент — оно у протоколов разное. */
  app: string;
}

export const PROTOCOLS: readonly ProtocolInfo[] = [
  {
    id: 'vless_ws_tls',
    button: '🌐 VLESS + WS + TLS (рекомендую)',
    line:
      '🌐 VLESS + WS + TLS — выглядит как обычный сайт со своим сертификатом. Лучше всех проходит у ' +
      'строгих операторов. Приложение для клиентов: OneXray. Нужен домен — я заведу его сам.',
    app: 'OneXray',
  },
  {
    id: 'vless_reality',
    button: '🛡 VLESS + Reality',
    line:
      '🛡 VLESS + Reality — без домена и очень быстрый, но у части операторов (например, Вайнах Телеком) ' +
      'поток режут. Приложение: OneXray.',
    app: 'OneXray',
  },
  {
    id: 'amneziawg',
    button: '🔒 AmneziaWG',
    line:
      '🔒 AmneziaWG — свой протокол на UDP. Приложение для клиентов: AmneziaVPN. Не подходит, если ' +
      'оператор клиента режет UDP; подписки-ссылки и лимит трафика на нём не работают.',
    app: 'AmneziaVPN',
  },
];

export function protocolQuestion(): string {
  return (
    '🔧 Какой протокол поставить на этот сервер?\n\n' +
    PROTOCOLS.map((p) => p.line).join('\n\n') +
    '\n\nНе уверен — бери первый.'
  );
}

export function protocolKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROTOCOLS) kb.text(p.button, PROTOCOL_CALLBACK_PREFIX + p.id).row();
  return kb;
}

/** `proto:vless_reality` → 'vless_reality'; всё чужое → null (не угадываем). */
export function parseProtocolCallback(data: string): NodeProtocol | null {
  if (!data.startsWith(PROTOCOL_CALLBACK_PREFIX)) return null;
  const id = data.slice(PROTOCOL_CALLBACK_PREFIX.length);
  return PROTOCOLS.some((p) => p.id === id) ? (id as NodeProtocol) : null;
}

export function protocolLabel(id: NodeProtocol): string {
  return PROTOCOLS.find((p) => p.id === id)?.button.replace(/^\S+\s/, '').replace(/ \(рекомендую\)$/, '') ?? id;
}
