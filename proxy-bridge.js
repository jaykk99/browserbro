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
  // Chunked upstream bodies must be decoded before res.write(): Node
  // re-chunks whatever we write, so forwarding raw chunk frames made
  // clients receive the framing bytes as the body.
  let chunked = false;
  let chunkBuf = Buffer.alloc(0);
  let chunkState = 'size'; // size | data | crlf | trailer | done
  let chunkLeft = 0;
  function feedChunked(data) {
    chunkBuf = Buffer.concat([chunkBuf, data]);
    for (;;) {
      if (chunkState === 'done') return;
      if (chunkState === 'size') {
        const idx = chunkBuf.indexOf('\r\n');
        if (idx === -1) return;
        const size = parseInt(chunkBuf.slice(0, idx).toString().trim().split(';')[0].trim(), 16);
        if (!Number.isInteger(size) || size < 0) { fail(502); return; }
        chunkBuf = chunkBuf.slice(idx + 2);
        if (size === 0) { chunkState = 'trailer'; continue; }
        chunkLeft = size;
        chunkState = 'data';
      } else if (chunkState === 'data') {
        if (chunkBuf.length === 0) return;
        const take = Math.min(chunkLeft, chunkBuf.length);
        if (take > 0) { res.write(chunkBuf.slice(0, take)); chunkBuf = chunkBuf.slice(take); chunkLeft -= take; }
        if (chunkLeft === 0) chunkState = 'crlf';
      } else if (chunkState === 'crlf') {
        if (chunkBuf.length < 2) return;
        chunkBuf = chunkBuf.slice(2);
        chunkState = 'size';
      } else { // trailer
        const idx = chunkBuf.indexOf('\r\n');
        if (idx === -1) return;
        if (idx === 0) { chunkBuf = chunkBuf.slice(2); chunkState = 'done'; return; }
        chunkBuf = chunkBuf.slice(idx + 2);
      }
    }
  }
  function writeBody(data) {
    if (!data.length) return;
    if (chunked) feedChunked(data);
    else res.write(data);
  }
  // Without these the client hangs forever when the upstream is down: the
  // connect error used to surface only as an uncaughtException while the
  // response never ended.
  const fail = (code) => {
    if (res.writableEnded) return;
    try { if (!res.headersSent) res.writeHead(code); } catch {}
    try { res.end(); } catch {}
    upSocket.destroy();
  };
  upSocket.on('error', () => fail(502));
  upSocket.on('close', () => { if (!res.writableEnded) fail(502); });
  upSocket.on('data', (chunk) => {
    if (gotHead) { writeBody(chunk); return; }
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 65536) { fail(502); return; } // upstream never sent a header block
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    gotHead = true;
    const headText = buf.slice(0, end).toString();
    const [statusLine, ...headerLines] = headText.split('\r\n');
    const status = parseInt(statusLine.split(' ')[1] || '502', 10);
    if (!Number.isInteger(status) || status < 100 || status > 999) { fail(502); return; }
    const headers = {};
    for (const line of headerLines) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    // Hop-by-hop headers must not be forwarded: the decoded body is piped
    // through res.write(), so Node must own the framing. Forwarding the
    // upstream transfer-encoding made clients receive raw chunk frames
    // as the body instead of the decoded content.
    chunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
    delete headers['transfer-encoding'];
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    res.writeHead(status, headers);
    const rest = buf.slice(end + 4);
    if (rest.length) writeBody(rest);
  });
  upSocket.on('end', () => res.end());
  req.on('error', () => upSocket.destroy());
});

// HTTPS: CONNECT tunnel. Authenticate with upstream, then pipe bytes.
server.on('connect', (req, clientSocket, head) => {
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
  clientSocket.on('close', () => { upSocket.destroy(); });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`proxy-bridge listening on http://127.0.0.1:${PORT} -> upstream ${UP_HOST}:${UP_PORT}`);
});
