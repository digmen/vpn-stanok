const { NodeSSH } = require('node-ssh');
const ssh = new NodeSSH();
const conf = JSON.stringify({
  log: { loglevel: "warning" },
  inbounds: [{ listen: "127.0.0.1", port: 10877, protocol: "socks", settings: { udp: false } }],
  outbounds: [{
    protocol: "vless",
    settings: { vnext: [{ address: "kerry.zone", port: 443,
      users: [{ id: "449d1fd9-a20d-4295-b843-1f23019ca6f2", encryption: "none" }] }] },
    streamSettings: { network: "ws", security: "tls",
      tlsSettings: { serverName: "kerry.zone", alpn: ["http/1.1"] },
      wsSettings: { path: "/d6831b8c82270295", headers: { Host: "kerry.zone" } } }
  }]
});
(async () => {
  await ssh.connect({ host: '89.125.212.208', username: 'root', password: process.env.SRV_PW });
  await ssh.execCommand(`cat > /tmp/sp.json << 'JEOF'\n${conf}\nJEOF`);
  const r = await ssh.execCommand(
    'nohup xray run -config /tmp/sp.json > /tmp/sp.log 2>&1 & sleep 3; ' +
    'P="--socks5-hostname 127.0.0.1:10877"; ' +
    'echo "== 1) одиночная закачка 10MB через туннель =="; ' +
    'curl -s -o /dev/null -w "скорость: %{speed_download} B/s, время: %{time_total}s, код:%{http_code}\n" --max-time 60 $P "https://speed.cloudflare.com/__down?bytes=10000000"; ' +
    'echo "== 2) 8 ПАРАЛЛЕЛЬНЫХ закачек по 2MB (как делает спидтест) =="; ' +
    'START=$(date +%s.%N); ' +
    'for i in $(seq 1 8); do curl -s -o /dev/null -w "поток$i: код:%{http_code} %{speed_download} B/s\n" --max-time 60 $P "https://speed.cloudflare.com/__down?bytes=2000000" & done; wait; ' +
    'END=$(date +%s.%N); echo "все 8 потоков заняли: $(echo "$END - $START" | bc)s"; ' +
    'pkill -f sp.json; rm -f /tmp/sp.json /tmp/sp.log'
  );
  console.log(r.stdout);
  if (r.stderr) console.log('ERR:', r.stderr.slice(0,500));
  ssh.dispose();
})().catch(e => { console.error(e); process.exit(1); });
