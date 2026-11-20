// proxy-bridge.js - local auth bridge for upstream proxies that require
// preemptive Proxy-Authorization.
//
// Why this exists: some egress proxies (like this sandbox's) drop an
// unauthenticated CONNECT instead of answering 407, so Chromium never gets
// to send its credentials and every request fails with
// ERR_TUNNEL_CONNECTION_FAILED / ERR_EMPTY_RESPONSE. curl works because it
// sends Proxy-Authorization preemptively.
//
// The bridge listens on localhost (default :3129), accepts unauthenticated
// requests from Chromium, and forwards them to the upstream proxy with the
// Proxy-Authorization header already attached. It handles both plain HTTP
// (absolute-URI requests) and HTTPS (CONNECT tunnels).
//
// Usage:
//   UPSTREAM_PROXY=http://user:pass@proxy-host:3128 node proxy-bridge.js
//   # then point browserbro at it:
//   BROWSERBRO_PROXY=http://127.0.0.1:3129 npm start
//
// No credentials are logged. Only use on localhost.
const http = require('http');
const net = require('net');
const dns = require('dns');

const upstreamRaw = process.env.UPSTREAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (!upstreamRaw) {
  console.error('proxy-bridge: set UPSTREAM_PROXY (or HTTPS_PROXY) to the upstream proxy URL');
  process.exit(1);
}
const upstream = new URL(upstreamRaw);
// Resolve the upstream host to IPv4: some sandboxes list the proxy on an
// IPv6 address that it does not actually listen on (curl falls back to
// IPv4, Node's net.connect does not always).
let UP_HOST = upstream.hostname;
const UP_PORT = parseInt(upstream.port || '80', 10);
try {
  const addrs = dns.lookupSync(UP_HOST, { family: 4, all: true });
  if (addrs.length) UP_HOST = addrs[0].address;
} catch (e) { /* keep the hostname */ }
const AUTH = upstream.username
  ? 'Basic ' + Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password || '')}`).toString('base64')
  : null;
const PORT = parseInt(process.env.BRIDGE_PORT || '3129', 10);

// Never let one bad request kill the bridge.
process.on('uncaughtException', (e) => console.error('proxy-bridge uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('proxy-bridge rejection:', e && e.message));

// (Plain HTTP is forwarded over a raw socket below; see the request handler.)

// Plain HTTP: forward the absolute-URI request to the upstream proxy over a
// raw socket. (Node's http client refuses a Host header that differs from
// the connection authority, which is exactly what a proxy request needs,
// so we write the request bytes ourselves.)
const server = http.createServer((req, res) => {
  const target = req.url; // absolute URI when talking through a proxy
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400); res.end('proxy-bridge: expected absolute URI');
    return;
  }
  let targetHost;
  try { targetHost = new URL(target).host; } catch { res.writeHead(400); res.end('proxy-bridge: bad URL'); return; }
  const upSocket = net.connect(UP_PORT, UP_HOST, () => {
    const lines = [`${req.method} ${target} HTTP/1.1`, `Host: ${targetHost}`];
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'proxy-authorization' || lk === 'proxy-connection') continue;
      lines.push(`${k}: ${v}`);
    }
    if (AUTH) lines.push(`Proxy-Authorization: ${AUTH}`);
    lines.push('Connection: close', '', '');
    upSocket.write(lines.join('\r\n'));
    req.pipe(upSocket, { end: true });
  });
  let gotHead = false;
  let buf = Buffer.alloc(0);
  upSocket.on('data', (chunk) => {
    if (gotHead) { res.write(chunk); return; }
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    gotHead = true;
    const headText = buf.slice(0, end).toString();
    const [statusLine, ...headerLines] = headText.split('\r\n');
    const status = parseInt(statusLine.split(' ')[1] || '502', 10);
    const headers = {};
    for (const line of headerLines) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    res.writeHead(status, headers);
    const rest = buf.slice(end + 4);
    if (rest.length) res.write(rest);
  });
  upSocket.on('end', () => res.end());
  req.on('error', () => upSocket.destroy());
});

// HTTPS: CONNECT tunnel. Authenticate with upstream, then pipe bytes.
server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const upSocket = net.connect(UP_PORT, UP_HOST, () => {
    const lines = [
      `CONNECT ${req.url} HTTP/1.1`,
      `Host: ${req.url}`,
      ...(AUTH ? [`Proxy-Authorization: ${AUTH}`] : []),
      'Proxy-Connection: keep-alive',
      '', '',
    ];
    upSocket.write(lines.join('\r\n'));
  });
  let established = false;
  let buf = Buffer.alloc(0);
  upSocket.on('data', (chunk) => {
    if (established) { clientSocket.write(chunk); return; }
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const headText = buf.slice(0, end).toString();
    const status = parseInt((headText.split(' ')[1] || '0'), 10);
    if (status === 200) {
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(end + 4);
      if (rest.length) upSocket.write(rest);
      if (head && head.length) upSocket.write(head);
      // Stop the manual data handler before piping, or bytes flow twice.
      upSocket.removeAllListeners('data');
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    } else {
      clientSocket.write(`HTTP/1.1 ${status} Proxy Error\r\n\r\n`);
      clientSocket.end();
      upSocket.end();
    }
  });
  upSocket.on('error', () => { clientSocket.end(); });
  clientSocket.on('error', () => { upSocket.end(); });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`proxy-bridge listening on http://127.0.0.1:${PORT} -> upstream ${UP_HOST}:${UP_PORT}`);
});
