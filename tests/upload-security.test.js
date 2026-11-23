'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uploadPayload, cleanupUpload } = require('../upload-security');

test('same original filename stays isolated in separate upload buffers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbro-upload-'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  try {
    fs.writeFileSync(a, 'private-A');
    fs.writeFileSync(b, 'private-B');
    const first = uploadPayload({ path: a, originalname: 'same.txt', mimetype: 'text/plain' });
    const second = uploadPayload({ path: b, originalname: 'same.txt', mimetype: 'text/plain' });
    assert.equal(first.name, 'same.txt');
    assert.equal(second.name, 'same.txt');
    assert.equal(first.buffer.toString(), 'private-A');
    assert.equal(second.buffer.toString(), 'private-B');
    cleanupUpload({ path: a });
    cleanupUpload({ path: b });
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(first.buffer.toString(), 'private-A');
    assert.equal(second.buffer.toString(), 'private-B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup is idempotent and payload never uses user filename as filesystem destination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbro-upload-'));
  const file = path.join(dir, 'random-multer-name');
  try {
    fs.writeFileSync(file, 'data');
    const payload = uploadPayload({ path: file, originalname: '../../secret.txt' });
    assert.equal(payload.name, 'secret.txt');
    assert.equal(payload.buffer.toString(), 'data');
    cleanupUpload({ path: file });
    cleanupUpload({ path: file });
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
