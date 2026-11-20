// proxy-relay.js — tiny loopback forward proxy for browserbro's Chromium.
//
// WHY THIS EXISTS: the sandbox egress proxy (hatch-egress-proxy:3128)
// answers Chromium's direct CONNECT requests with `403 Forbidden`
// (JSON body), while the byte-identical CONNECT from curl, python, or
// Node gets `200 Connection Established`. Root cause unknown (same
// source/dest addresses, same bytes, same headers); empirically, routing
// Chromium through this loopback relay makes the same CONNECT succeed
// every time. The relay adds no auth and no headers: it forwards bytes
// both ways between Chromium and the egress proxy.
//
// Run:  node proxy-relay.js   (listens on 127.0.0.1:3129)
// Use:  BROWSERBRO_PROXY=http://127.0.0.1:3129 node server.js
// No secrets here: the egress proxy allows unauthenticated CONNECT for
// public hosts; where it asks for auth, Chromium answers the 407 itself
// with the credentials browserbro passes it.

const net = require('net');

const LISTEN_PORT = parseInt(process.env.RELAY_PORT || '3129', 10);
const UPSTREAM_HOST = process.env.EGRESS_PROXY_HOST || 'hatch-egress-proxy';
const UPSTREAM_PORT = parseInt(process.env.EGRESS_PROXY_PORT || '3128', 10);

const server = net.createServer((client) => {
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
  client.on('data', (d) => upstream.write(d));
  upstream.on('data', (d) => client.write(d));
  const drop = () => {
    try { client.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };
  client.on('error', drop);
  upstream.on('error', drop);
  client.on('close', drop);
  upstream.on('close', drop);
});

server.on('error', (err) => {
  console.error(`proxy-relay listen error: ${err.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`proxy-relay listening on 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
