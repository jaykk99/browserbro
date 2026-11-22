'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { withStagedUpload } = require('../upload-storage');

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserbro-upload-test-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test('concurrent same-name uploads stay isolated and clean up', async () => fixture(async dir => {
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  await fs.writeFile(a, 'alpha'); await fs.writeFile(b, 'beta');
  const seen = await Promise.all([a, b].map((p, i) => withStagedUpload(
    { path: p, originalname: 'same.txt' }, dir,
    async staged => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return [staged, await fs.readFile(staged, 'utf8')];
    }
  )));
  assert.notEqual(seen[0][0], seen[1][0]);
  assert.deepEqual(seen.map(v => v[1]), ['alpha', 'beta']);
  assert.deepEqual(await fs.readdir(dir), []);
}));
test('failed browser upload removes staged and multer temp files', async () => fixture(async dir => {
  const temp = path.join(dir, 'temp');
  await fs.writeFile(temp, 'payload');
  await assert.rejects(withStagedUpload({ path: temp, originalname: '../evil.txt' }, dir, async staged => {
    assert.equal(path.dirname(path.dirname(staged)), dir);
    throw new Error('browser failed');
  }), /browser failed/);
  assert.deepEqual(await fs.readdir(dir), []);
}));
test('copy failure still removes multer temp', async () => fixture(async dir => {
  const missing = path.join(dir, 'missing');
  await assert.rejects(withStagedUpload({ path: missing, originalname: 'x' }, dir, async () => {}));
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('Docker image includes upload-storage runtime dependency', async () => {
  const dockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY\s+[^\n]*\bupload-storage\.js\b[^\n]*\s+\.\/$/m);
});
