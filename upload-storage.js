'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Keep each upload's original basename for HTML file inputs without sharing
// a path between sessions. Always remove both multer's temp and staged file.
async function withStagedUpload(file, uploadsDir, callback) {
  if (!file || !file.path) throw new TypeError('missing upload');
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(uploadsDir, 'stage-'));
    const name = path.basename(String(file.originalname || 'upload').replace(/\\/g, '/'));
    const staged = path.join(directory, name === '.' || name === '..' || !name ? randomUUID() : name);
    await fs.copyFile(file.path, staged);
    return await callback(staged);
  } finally {
    await Promise.allSettled([
      fs.rm(file.path, { force: true }),
      directory ? fs.rm(directory, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}
module.exports = { withStagedUpload };
