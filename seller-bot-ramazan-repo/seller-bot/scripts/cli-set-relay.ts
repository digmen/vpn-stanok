// Точка входа ДЛЯ СТАНКА: включает/выключает релей-адрес для конкретной локации
// в ЭТОМ боте-продавце — см. locations.ts::setClientEndpoint/clearClientEndpoint
// и vpn.ts (учитывает relay раньше обычного host-фикса). SSH-адрес локации
// (для управления/поддержки) этим не трогается — меняется только то, что
// получает клиент в готовой ссылке.
//
// usage: tsx cli-set-relay.ts <locationId> clear
//        tsx cli-set-relay.ts <locationId> <relayHost> <relayPort>
import { clearClientEndpoint, setClientEndpoint } from '../src/locations.js';

const [locationId, a, b] = process.argv.slice(2);
if (!locationId || !a) {
  console.error('usage: cli-set-relay.ts <locationId> clear | cli-set-relay.ts <locationId> <relayHost> <relayPort>');
  process.exit(1);
}

if (a === 'clear') {
  clearClientEndpoint(locationId);
  console.log(JSON.stringify({ locationId, cleared: true }));
} else {
  const port = Number(b);
  if (!b || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('нужен корректный relayPort вторым аргументом');
    process.exit(1);
  }
  setClientEndpoint(locationId, a, port);
  console.log(JSON.stringify({ locationId, host: a, port }));
}
