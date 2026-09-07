import { config } from './config.js';

// 🔴 06.09: у него есть свободный домен на GoDaddy (fleurdelis-club.site), но у GoDaddy
// нет API без Production-ключа (которого нет и не факт что дадут) — автоматика через их
// API невозможна в принципе. Решение — свой PowerDNS на пражском сервере (том же, где
// станок), домен просто передаётся ему NS-записями в GoDaddy один раз руками. Дальше
// станок сам, по локальному HTTP API PowerDNS (127.0.0.1, наружу не торчит), заводит
// A-запись на каждый успешно поднятый узел — nodeN.<домен> → IP узла. Чисто для удобства/
// референса (посмотреть глазами, куда что показывает), сам VLESS+Reality как использовал
// голый IP без домена (осознанное решение 05.09 — без домена и сертификата), так и продолжает.
//
// 🔴 08.09: запись перестала быть «для удобства». С переходом новых узлов на VLESS+WS+TLS
// (см. scripts/install-vless-ws-tls.sh) домен стал НЕСУЩИМ: на него выписывается сертификат
// Let's Encrypt, и без работающей A-записи узел просто не поднимется. Поэтому теперь:
// 1) запись заводится ДО установки, а не после успеха (иначе certbot нечего проверять);
// 2) функция сообщает результат, а вызывающий решает, что делать при провале —
//    провижининг откатывается на Reality, которому домен не нужен.
/** Имя узла в нашей зоне. null — зона не настроена, доменных протоколов не будет. */
export function nodeDomain(nodeId: number): string | null {
  return config.pdns.zone ? `node${nodeId}.${config.pdns.zone}` : null;
}

/** true — A-запись заведена и можно выписывать сертификат. */
export async function registerNodeDns(nodeId: number, ip: string): Promise<boolean> {
  if (!config.pdns.zone || !config.pdns.apiKey) return false;

  const name = `node${nodeId}.${config.pdns.zone}.`;
  const body = {
    rrsets: [
      {
        name,
        type: 'A',
        ttl: 3600,
        changetype: 'REPLACE',
        records: [{ content: ip, disabled: false }],
      },
    ],
  };

  try {
    const res = await fetch(`${config.pdns.apiUrl}/zones/${config.pdns.zone}.`, {
      method: 'PATCH',
      headers: { 'X-API-Key': config.pdns.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`⚠️ registerNodeDns(${nodeId}): PowerDNS ответил ${res.status}.`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`⚠️ registerNodeDns(${nodeId}): PowerDNS недоступен (${e instanceof Error ? e.message : e}).`);
    return false;
  }
}
