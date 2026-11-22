const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { normalizeAccessCode, verifyBuyerCode, buyerCodeAuth, anyAuth } = require('../api-auth');

const GOOD = 'ML-2345-6789-ABCD-EFGH'.replace(/[IO]/g, '0'); // canonical form
const GRANTS = [{ product: 'browserbro', tier: 'pro' }];
const OTHER_GRANTS = [{ product: 'code-runner', tier: 'pro' }];

function stubFetch(grants, status = 200) {
  let calls = 0;
  const fn = async (url, opts) => {
    calls += 1;
    assert.match(url, /\/api\/auth\/code$/);
    assert.equal(JSON.parse(opts.body).code, GOOD);
    return { status, ok: status >= 200 && status < 300, json: async () => ({ grants }) };
  };
  fn.calls = () => calls;
  return fn;
}

async function withApp(middleware, fn) {
  const app = express();
  app.use('/api', middleware);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('normalizeAccessCode accepts the hub canonical form and look-alikes', () => {
  assert.equal(normalizeAccessCode('ML-2345-6789-ABCD-EFGH'), GOOD);
  assert.equal(normalizeAccessCode('ml 2345 6789 abcd efgh'), GOOD);
  assert.equal(normalizeAccessCode('23456789ABCDEFGH'), GOOD);
  assert.equal(normalizeAccessCode('ML-2345-6789-ABCD-EFGI'), GOOD.replace(/H$/, '1')); // I -> 1
  assert.equal(normalizeAccessCode('ML-2345-6789-ABCD-EFGO'), GOOD.replace(/H$/, '0')); // O -> 0
  for (const bad of ['', 'ML-123', 'ML-2345-6789-ABCD-EFG!', 'not a code at all']) {
    assert.equal(normalizeAccessCode(bad), null, bad);
  }
});

test('verifyBuyerCode returns grants and caches the second check', async () => {
  const fetchImpl = stubFetch(GRANTS);
  const cache = new Map();
  assert.deepEqual(await verifyBuyerCode(GOOD, { hubUrl: 'https://hub.test', fetchImpl, cache }), GRANTS);
  assert.deepEqual(await verifyBuyerCode(GOOD.toLowerCase(), { hubUrl: 'https://hub.test', fetchImpl, cache }), GRANTS);
  assert.equal(fetchImpl.calls(), 1);
});

test('verifyBuyerCode maps hub failures to honest statuses', async () => {
  await assert.rejects(
    verifyBuyerCode(GOOD, { hubUrl: 'https://hub.test', fetchImpl: stubFetch([], 401) }),
    (e) => e.status === 401);
  await assert.rejects(
    verifyBuyerCode(GOOD, { hubUrl: 'https://hub.test', fetchImpl: stubFetch([], 500) }),
    (e) => e.status === 502);
  await assert.rejects(
    verifyBuyerCode(GOOD, { hubUrl: 'https://hub.test', fetchImpl: async () => { throw new Error('down'); } }),
    (e) => e.status === 503);
  await assert.rejects(
    verifyBuyerCode('bogus', { hubUrl: 'https://hub.test', fetchImpl: stubFetch(GRANTS) }),
    (e) => e.status === 401);
});

test('buyerCodeAuth: no code 401, browserbro grant 200, other product 403, bad code 401', async () => {
  const mw = buyerCodeAuth('https://hub.test', { fetchImpl: stubFetch(GRANTS) });
  await withApp(mw, async (base) => {
    assert.equal((await fetch(base + '/api/health')).status, 401);
    const ok = await fetch(base + '/api/health', { headers: { 'X-Access-Code': GOOD } });
    assert.equal(ok.status, 200);
    const viaQuery = await fetch(base + '/api/health?code=' + encodeURIComponent(GOOD));
    assert.equal(viaQuery.status, 200);
  });
  const wrongProduct = buyerCodeAuth('https://hub.test', { fetchImpl: stubFetch(OTHER_GRANTS) });
  await withApp(wrongProduct, async (base) => {
    const r = await fetch(base + '/api/health', { headers: { 'X-Access-Code': GOOD } });
    assert.equal(r.status, 403);
  });
  const badCode = buyerCodeAuth('https://hub.test', { fetchImpl: stubFetch([], 401) });
  await withApp(badCode, async (base) => {
    const r = await fetch(base + '/api/health', { headers: { 'X-Access-Code': GOOD } });
    assert.equal(r.status, 401);
  });
});

test('anyAuth: token or buyer code opens the API, neither configured stays open', async () => {
  await withApp(anyAuth('', ''), async (base) => {
    assert.equal((await fetch(base + '/api/health')).status, 200);
  });
  await withApp(anyAuth('op-token', 'https://hub.test', { fetchImpl: stubFetch(GRANTS) }), async (base) => {
    assert.equal((await fetch(base + '/api/health')).status, 401);
    assert.equal((await fetch(base + '/api/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(base + '/api/health', { headers: { Authorization: 'Bearer op-token' } })).status, 200);
    assert.equal((await fetch(base + '/api/health', { headers: { 'X-Access-Code': GOOD } })).status, 200);
  });
  await withApp(anyAuth('op-token', ''), async (base) => {
    assert.equal((await fetch(base + '/api/health')).status, 401);
    assert.equal((await fetch(base + '/api/health', { headers: { Authorization: 'Bearer op-token' } })).status, 200);
  });
});
