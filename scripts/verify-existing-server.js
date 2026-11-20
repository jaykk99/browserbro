'use strict';
// E2E check of the actual running Docker BrowserBro, not a mock server.
const BASE = process.env.BROWSERBRO_BASE_URL || 'http://127.0.0.1:3101';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadlineMs = 45000;
let sid;
async function api(path, opts = {}) {
  const response = await fetch(BASE + path, {
    signal: AbortSignal.timeout(deadlineMs),
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await response.json();
  return { response, body };
}
function expect(ok, detail) {
  console.log((ok ? 'PASS: ' : 'FAIL: ') + detail);
  if (!ok) throw new Error(detail);
}
(async () => {
  try {
    let online = false;
    for (let i = 0; i < 100; i++) {
      try { const { body } = await api('/api/health'); if (body.ok) { online = true; break; } } catch {}
      await sleep(350);
    }
    expect(online, 'Docker BrowserBro HTTP health responds');
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'docker-e2e' }) });
    sid = created.body.session?.id;
    expect(!!sid && created.response.status === 201, 'Docker Chromium session starts');
    const terminal = await api('/api/sessions/' + sid + '/terminal', {
      method: 'POST', body: JSON.stringify({ command: 'open https://example.org' }),
    });
    expect(terminal.body.ok && new URL(terminal.body.url).hostname === 'example.org', 'Docker terminal navigates real external URL');
    const title = await api('/api/sessions/' + sid + '/title');
    expect(/Example Domain/i.test(title.body.title || ''), 'Docker reads external page title');
    const navigated = await api('/api/sessions/' + sid + '/navigate', {
      method: 'POST', body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(navigated.body.ok && new URL(navigated.body.url).hostname === 'example.com', 'Docker dashboard API navigates real external URL');
    const pngResp = await fetch(BASE + '/api/sessions/' + sid + '/screenshot', { signal: AbortSignal.timeout(deadlineMs) });
    const png = Buffer.from(await pngResp.arrayBuffer());
    expect(pngResp.ok && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.length > 1000, 'Docker Chromium screenshot is a real PNG (' + png.length + ' bytes)');
    console.log('DOCKER LIVE PUBLIC BROWSING: ALL CHECKS PASSED');
  } catch (e) {
    console.error('DOCKER LIVE PUBLIC BROWSING: FAILED: ' + (e.stack || e));
    process.exitCode = 1;
  } finally {
    if (sid) {
      try { await api('/api/sessions/' + sid, { method: 'DELETE' }); } catch {}
    }
  }
})();
