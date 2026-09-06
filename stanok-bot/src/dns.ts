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
// Намеренно best-effort: если PDNS_ZONE не задан или API недоступен — тихо пропускаем,
// провижининг узла не должен падать из-за DNS-мелочи.
export async function registerNodeDns(nodeId: number, ip: string): Promise<void> {
  if (!config.pdns.zone || !config.pdns.apiKey) return;

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
      console.warn(`⚠️ registerNodeDns(${nodeId}): PowerDNS ответил ${res.status} — узел это не блокирует.`);
    }
  } catch (e) {
    console.warn(`⚠️ registerNodeDns(${nodeId}): PowerDNS недоступен (${e instanceof Error ? e.message : e}).`);
  }
}
