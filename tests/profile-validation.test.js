// Regression: invalid persistent profile names must be rejected before Chromium starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('persistent profiles reject traversal and malformed names over HTTP', async t => {
  const port = await freePort();
  const token = 'profile-regression-local-only';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, BROWSERBRO_HOST: '127.0.0.1', BROWSERBRO_PORT: String(port), BROWSERBRO_TOKEN: token },
    stdio: 'ignore',
  });
  t.after(() => { if (!child.killed) child.kill(); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(origin + '/api/health', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'BrowserBro server did not become ready');
  for (const profile of ['../escape', '..', '/tmp/escape', 'a/b', 'a\\b', '.hidden', 'bad name', 'x'.repeat(65), 17, {}, []]) {
    const response = await fetch(origin + '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ persistent: true, profile }),
    });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(profile)}`);
    assert.equal((await response.json()).error, 'invalid_profile');
  }
  const response = await fetch(origin + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persistent: true, profile: '../escape' }),
  });
  assert.equal(response.status, 401, 'unauthenticated API access must be denied');
});
