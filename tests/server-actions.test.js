// Regression: /wait clamping (explicit 0 means 0, negatives clamp to 0) and
// the download size cap (responses over BROWSERBRO_MAX_DOWNLOAD_BYTES fail
// honestly instead of buffering unbounded bytes into memory).
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

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  // Await the exit so the child handle releases and the test file can end.
  // (A server with live sessions used to ignore SIGTERM entirely — see the
  // gracefulShutdown fix in server.js — so escalate rather than hang.)
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

async function startServer(t, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, BROWSERBRO_HOST: '127.0.0.1', BROWSERBRO_PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
  t.after(() => stopChild(child));
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(origin + '/api/health');
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'BrowserBro server did not become ready');
  return origin;
}

async function createSession(origin) {
  const r = await fetch(origin + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'server-actions-test' }),
  });
  assert.equal(r.status, 201, 'session create must succeed');
  return (await r.json()).session.id;
}

test('wait clamps negatives and honors explicit zero', async (t) => {
  const origin = await startServer(t);
  const sid = await createSession(origin);
  t.after(async () => { try { await fetch(origin + '/api/sessions/' + sid, { method: 'DELETE' }); } catch {} });

  const neg = await fetch(origin + `/api/sessions/${sid}/wait`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms: -500 }),
  });
  assert.equal(neg.status, 200);
  assert.equal((await neg.json()).waited_ms, 0);

  const started = Date.now();
  const zero = await fetch(origin + `/api/sessions/${sid}/wait`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms: 0 }),
  });
  assert.equal(zero.status, 200);
  assert.equal((await zero.json()).waited_ms, 0);
  assert.ok(Date.now() - started < 500, 'explicit 0 must not wait ~1s');

  const small = await fetch(origin + `/api/sessions/${sid}/wait`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms: 200 }),
  });
  assert.equal((await small.json()).waited_ms, 200);
});

test('download enforces the size cap and leaves no partial file', async (t) => {
  const fileServer = http.createServer((req, res) => {
    if (req.url === '/small') { res.writeHead(200); res.end('x'.repeat(100)); return; }
    if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(2048)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve));
  const filePort = fileServer.address().port;
  // closeAllConnections first: the download fetch holds a keep-alive socket
  // open, and plain close() waits for it forever (the test file would hang
  // after passing, and CI with it).
  t.after(() => { fileServer.closeAllConnections(); fileServer.close(); });

  const origin = await startServer(t, { BROWSERBRO_MAX_DOWNLOAD_BYTES: '1024' });
  const sid = await createSession(origin);
  t.after(async () => { try { await fetch(origin + '/api/sessions/' + sid, { method: 'DELETE' }); } catch {} });

  const small = await fetch(origin + `/api/sessions/${sid}/download`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${filePort}/small` }),
  });
  assert.equal(small.status, 200);
  assert.equal((await small.json()).bytes, 100);

  const big = await fetch(origin + `/api/sessions/${sid}/download`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${filePort}/big` }),
  });
  assert.equal(big.status, 502);
  assert.equal((await big.json()).error, 'download_failed');
  const leftover = await fetch(origin + '/api/downloads/big');
  assert.equal(leftover.status, 404, 'over-cap download must not leave a file behind');
});
