'use strict';
// Run against real external HTTPS hosts, using this repository's actual Express
// API and a real local Chromium browser. Never mark "reachable" from mocks.
const { spawn } = require('node:child_process');
const { lookup } = require('node:dns').promises;
const { setTimeout: sleep } = require('node:timers/promises');

const PORT = Number(process.env.BROWSERBRO_VERIFY_PORT || 41873);
const BASE = 'http://127.0.0.1:' + PORT;
const URLS = [
  { url: 'https://example.com', host: 'example.com', expected: /Example Domain/i },
  { url: 'https://github.com', host: 'github.com', expected: /GitHub/i },
];
const TIMEOUT = 55000;
let child = null;
let session = null;
let failures = 0;

function assertResult(ok, name, evidence) {
  const line = (ok ? 'PASS ' : 'FAIL ') + name + ': ' + evidence;
  console.log(line);
  if (!ok) failures++;
}
async function request(route, opts = {}) {
  const response = await fetch(BASE + route, {
    signal: AbortSignal.timeout(TIMEOUT),
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : await response.arrayBuffer();
  return { status: response.status, body };
}
async function waitForStartup() {
  for (let attempt = 0; attempt < 75; attempt++) {
    if (child.exitCode !== null) throw new Error('BrowserBro process exited early: ' + child.exitCode);
    try {
      const r = await request('/api/health');
      if (r.status === 200 && r.body.ok) return;
    } catch {}
    await sleep(350);
  }
  throw new Error('BrowserBro failed to become healthy');
}
async function diagnoseDNS(host) {
  try {
    const answers = await lookup(host, { all: true });
    console.log('DNS ' + host + ': ' + answers.map(a => a.address).join(', '));
    return answers.length > 0;
  } catch (error) {
    console.log('DNS ' + host + ': ' + String(error.code || error.message));
    return false;
  }
}
async function run() {
  for (const target of URLS) {
    const dnsOK = await diagnoseDNS(target.host);
    assertResult(dnsOK, 'DNS ' + target.host, dnsOK ? 'resolved' : 'not resolved');
  }
  child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, BROWSERBRO_PORT: String(PORT), BROWSERBRO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => process.stdout.write('[BrowserBro] ' + b));
  child.stderr.on('data', b => process.stderr.write('[BrowserBro stderr] ' + b));
  await waitForStartup();
  const created = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'public-internet-verification', persistent: false }),
  });
  session = created.body.session?.id;
  assertResult(created.status === 201 && !!session, 'real Chromium session created', JSON.stringify(created.body).slice(0, 350));
  if (!session) throw new Error('Cannot verify navigation without a real browser session');
  for (const target of URLS) {
    console.log('\n--- Live browser navigation: ' + target.url + ' ---');
    let nav;
    try {
      nav = await request('/api/sessions/' + session + '/terminal', {
        method: 'POST',
        body: JSON.stringify({ command: 'open ' + target.url }),
      });
    } catch (error) {
      assertResult(false, 'browser navigation ' + target.host, error.message);
      continue;
    }
    const actual = nav.body.url || '';
    const hostname = (() => { try { return new URL(actual).hostname; } catch { return ''; } })();
    const loaded = nav.status === 200 && nav.body.ok === true && hostname === target.host;
    assertResult(loaded, 'browser navigation ' + target.host, JSON.stringify(nav.body).slice(0, 450));
    if (!loaded) continue;
    const title = await request('/api/sessions/' + session + '/title');
    assertResult(title.status === 200 && target.expected.test(title.body.title || ''), 'real page title ' + target.host, JSON.stringify(title.body).slice(0, 350));
    const body = await request('/api/sessions/' + session + '/text');
    assertResult(body.status === 200 && (body.body.text || '').length > 35, 'rendered page text ' + target.host, String((body.body.text || '').length) + ' characters');
    const screenshot = await fetch(BASE + '/api/sessions/' + session + '/screenshot', { signal: AbortSignal.timeout(TIMEOUT) });
    const bytes = Buffer.from(await screenshot.arrayBuffer());
    assertResult(screenshot.ok && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a' && bytes.length > 1000, 'real screenshot ' + target.host, String(bytes.length) + ' bytes');
  }
  console.log('\n--- Dashboard Go-button API: real navigation to example.org ---');
  const dashboardNavigation = await request('/api/sessions/' + session + '/navigate', {
    method: 'POST', body: JSON.stringify({ url: 'https://example.org' }),
  });
  assertResult(dashboardNavigation.status === 200
    && dashboardNavigation.body.ok === true
    && new URL(dashboardNavigation.body.url).hostname === 'example.org'
    && /Example Domain/i.test(dashboardNavigation.body.title || ''),
    'dashboard navigate API loads example.org', JSON.stringify(dashboardNavigation.body).slice(0, 420));
  const dashboardText = await request('/api/sessions/' + session + '/text');
  assertResult(dashboardText.status === 200 && (dashboardText.body.text || '').length > 100,
    'dashboard navigation renders real content', String((dashboardText.body.text || '').length) + ' characters');
  const negativeNavigation = await request('/api/sessions/' + session + '/navigate', {
    method: 'POST', body: JSON.stringify({ url: 'https://does-not-exist.browserbro.invalid' }),
  });
  assertResult(negativeNavigation.status === 502 && negativeNavigation.body.ok === false,
    'unreachable domain reports real navigation failure', JSON.stringify(negativeNavigation.body).slice(0, 230));
}
(async function main() {
  try { await run(); } catch (e) { failures++; console.error('Verification crashed:', e.stack || e); }
  finally {
    if (session) {
      try { await request('/api/sessions/' + session, { method: 'DELETE' }); } catch {}
    }
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
  console.log('\nPUBLIC INTERNET VERIFICATION: ' + (failures ? failures + ' failure(s)' : 'ALL CHECKS PASSED'));
  process.exitCode = failures ? 1 : 0;
})();
