'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const uploads = path.join(root, 'data', 'uploads');
const token = 'upload-http-test-token';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real HTTP upload enforces authentication, size quota and temp cleanup', { timeout: 30000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, BROWSERBRO_HOST: '127.0.0.1', BROWSERBRO_PORT: String(port), BROWSERBRO_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const send = async (bytes, auth = true) => {
    const form = new FormData();
    form.append('file-upload', new Blob([Buffer.alloc(bytes, 0x61)]), 'same-name.txt');
    return fetch(base + '/api/test-upload', {
      method: 'POST',
      headers: auth ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: AbortSignal.timeout(12000),
    });
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error('server exited before readiness: ' + output);
      try {
        const response = await fetch(base + '/api/health', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(300),
        });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'server did not become ready: ' + output);
    const before = new Set(fs.readdirSync(uploads));
    const unauth = await send(8, false);
    assert.equal(unauth.status, 401, 'upload must require token');
    const accepted = await send(128);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).bytes, 128);
    const rejected = await send(8 * 1024 * 1024 + 1);
    assert.equal(rejected.status, 413);
    assert.equal((await rejected.json()).error, 'upload_limit_exceeded');
    assert.deepEqual(new Set(fs.readdirSync(uploads)), before, 'upload temp files leaked');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
});
