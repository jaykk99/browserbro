// Regression: proxy-bridge must answer a fast 502 when its upstream is down
// instead of letting the client hang (the plain-HTTP path used to have no
// upstream error/close handler, so the response never ended).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startBridge(upstream, port) {
  const child = spawn(process.execPath, ['proxy-bridge.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, UPSTREAM_PROXY: upstream, BRIDGE_PORT: String(port) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('proxy-bridge exited early: ' + child.exitCode);
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return child;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('proxy-bridge did not start listening');
}

function proxyGet(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('proxy request timed out')));
    req.end();
  });
}

function proxyConnect(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('CONNECT timed out')); }, 5000);
    sock.on('data', (c) => { buf += c.toString(); });
    sock.on('end', () => { clearTimeout(timer); resolve(buf); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('plain HTTP to a dead upstream answers 502 instead of hanging', async (t) => {
  const port = await freePort();
  const bridge = await startBridge('http://127.0.0.1:1', port);
  t.after(() => { if (!bridge.killed) bridge.kill(); });
  const started = Date.now();
  const res = await proxyGet(port, 'http://example.com/');
  assert.equal(res.status, 502);
  assert.ok(Date.now() - started < 4000, 'answer must be fast, not a hang');
});

test('CONNECT to a dead upstream fails fast', async (t) => {
  const port = await freePort();
  const bridge = await startBridge('http://127.0.0.1:1', port);
  t.after(() => { if (!bridge.killed) bridge.kill(); });
  const started = Date.now();
  const head = await proxyConnect(port, 'example.com:443');
  assert.ok(!/^HTTP\/1\.1 200/.test(head), 'dead upstream must not report success: ' + head.slice(0, 80));
  assert.ok(Date.now() - started < 4000, 'CONNECT failure must be fast, not a hang');
});

test('working upstream still proxies plain HTTP and CONNECT', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('via-upstream');
  });
  upstream.on('connect', (_req, sock) => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    sock.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = upstream.address().port;
  t.after(() => upstream.close());
  const port = await freePort();
  const bridge = await startBridge(`http://127.0.0.1:${upPort}`, port);
  t.after(() => { if (!bridge.killed) bridge.kill(); });
  const res = await proxyGet(port, 'http://example.com/');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'via-upstream');
  const head = await proxyConnect(port, 'example.com:443');
  assert.match(head, /^HTTP\/1\.1 200 Connection Established/);
});
