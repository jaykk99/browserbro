// Take a screenshot of the real running dashboard for docs/ui-screenshot.png.
// Run: node shot-ui.js  (starts server on 3103, creates a session, screenshots dashboard)
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 3103;
const BASE = `http://localhost:${PORT}`;

// Same proxied-sandbox handling as smoke.js: point the server at the auth
// bridge when a proxy env var is set, starting the bridge if it is down.
async function bridgeUrl() {
  const upstream = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!upstream) return null;
  const alive = await new Promise((resolve) => {
    const s = net.connect(3129, '127.0.0.1');
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
  });
  if (alive) return 'http://127.0.0.1:3129';
  const b = spawn('node', ['proxy-bridge.js'], { cwd: __dirname, env: { ...process.env, UPSTREAM_PROXY: upstream, BRIDGE_PORT: '3129' }, stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ok = await new Promise((resolve) => {
      const s = net.connect(3129, '127.0.0.1');
      s.on('connect', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return 'http://127.0.0.1:3129';
  }
  b.kill('SIGTERM');
  return null;
}

(async () => {
  const bUrl = await bridgeUrl();
  const serverEnv = { ...process.env, BROWSERBRO_PORT: String(PORT) };
  if (bUrl) serverEnv.BROWSERBRO_PROXY = bUrl;
  const server = spawn('node', ['server.js'], {
    cwd: __dirname, env: serverEnv, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    // create a session so the dashboard has something to show
    const created = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ui-shot' }) });
    const sid = (await created.json()).session.id;
    await fetch(BASE + `/api/sessions/${sid}/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://news.ycombinator.com' }) });
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BROWSERBRO_CHROME_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // Select the session so the live view actually streams its page.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('#sessList > div')].find(d => d.textContent.includes('ui-shot'));
      if (el) el.click();
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(__dirname, 'docs', 'ui-screenshot.png') });
    await browser.close();
    await fetch(BASE + `/api/sessions/${sid}`, { method: 'DELETE' });
    const st = fs.statSync(path.join(__dirname, 'docs', 'ui-screenshot.png'));
    console.log('ui screenshot saved:', st.size, 'bytes');
  } finally {
    server.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  }
})().catch(e => { console.error(e); process.exit(1); });
