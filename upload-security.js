'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Never create a shared filename from untrusted originalname. Playwright
// consumes this payload directly and owns its copy after setInputFiles.
function uploadPayload(file) {
  if (!file || !file.path) throw new TypeError('missing upload');
  return {
    name: path.basename(file.originalname || 'upload.bin').replace(/[\\/]/g, '_'),
    mimeType: file.mimetype || 'application/octet-stream',
    buffer: fs.readFileSync(file.path),
  };
}

function cleanupUpload(file) {
  if (file && file.path) {
    try { fs.unlinkSync(file.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
module.exports = { uploadPayload, cleanupUpload };
