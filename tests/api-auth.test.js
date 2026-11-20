const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { apiAuth } = require('../api-auth');

async function withApp(token, fn) {
  const app = express();
  app.use('/api', apiAuth(token));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
test('No bearer configured permits loopback API calls', async () => {
  await withApp('', async base => {
    assert.equal((await fetch(base + '/api/health')).status, 200);
  });
});
test('Configured bearer protects all API calls', async () => {
  await withApp('a-private-token', async base => {
    assert.equal((await fetch(base + '/api/health')).status, 401);
    assert.equal((await fetch(base + '/api/health', {headers: {Authorization: 'Bearer wrong'}})).status, 401);
    assert.equal((await fetch(base + '/api/health', {headers: {Authorization: 'Bearer a-private-token'}})).status, 200);
  });
});
