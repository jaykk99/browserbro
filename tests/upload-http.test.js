'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const uploadDir = path.join(root, 'data', 'uploads');
const port = 39000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;

async function waitReady(child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('server exited before health check');
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server health check timed out');
}
async function postFile(url, bytes, field = 'file') {
  const form = new FormData();
  form.set('selector', 'input[type=file]');
  form.set(field, new Blob([bytes]), 'upload.txt');
  const response = await fetch(base + url, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}
test('HTTP multipart rejects oversize uploads and cleans temporary files', { timeout: 30000 }, async () => {
  const before = new Set(await fs.readdir(uploadDir).catch(() => []));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, BROWSERBRO_PORT: String(port), BROWSERBRO_HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  try {
    await waitReady(child);
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    for (const endpoint of ['/api/test-upload', '/api/sessions/not-a-session/upload']) {
      const field = endpoint === '/api/test-upload' ? 'file-upload' : 'file';
      const result = await postFile(endpoint, oversized, field);
      assert.equal(result.status, 413);
      assert.equal(result.body.error, 'upload_too_large');
      assert.equal(result.body.max_bytes, 20 * 1024 * 1024);
    }
    const missing = await postFile('/api/sessions/not-a-session/upload', new Uint8Array([1, 2, 3]));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'session_not_found');
    const ok = await postFile('/api/test-upload', new Uint8Array([1, 2, 3]), 'file-upload');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.bytes, 3);
    // Concurrent requests with identical filenames must not share temporary
    // files or leave orphaned uploads, even when handled by the same process.
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      postFile('/api/test-upload', new Uint8Array(i + 1).fill(i + 1), 'file-upload')
    ));
    concurrent.forEach((result, i) => {
      assert.equal(result.status, 200);
      assert.equal(result.body.bytes, i + 1);
      assert.equal(result.body.file, 'upload.txt');
    });
    assert.deepEqual((await fs.readdir(uploadDir)).filter(name => !before.has(name)), []);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
});
