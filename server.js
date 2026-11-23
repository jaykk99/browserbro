// browserbro - self-hosted Browserbase replacement.
// Real Chromium sessions via Playwright. No API keys, no credits, no card.
// Every endpoint does the real thing or returns an honest error.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const { installTerminal } = require('./agent-terminal');
const { apiAuth } = require('./api-auth');
const { uploadPayload, cleanupUpload } = require('./upload-security');

const PORT = parseInt(process.env.BROWSERBRO_PORT || '3101', 10);
// Private by default: the browser API has no authentication yet.
// Docker binds to all container interfaces explicitly; host ports stay loopback-only.
const HOST = process.env.BROWSERBRO_HOST || '127.0.0.1';
// Optional: point at a system Chrome/Chromium instead of the Playwright download.
// e.g. BROWSERBRO_CHROME_PATH=/opt/meta-chromium/chrome
const CHROME_PATH = process.env.BROWSERBRO_CHROME_PATH || process.env.CHROME_PATH || null;
const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const REPLAYS_DIR = path.join(DATA_DIR, 'replays');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
for (const d of [DATA_DIR, PROFILES_DIR, DOWNLOADS_DIR, REPLAYS_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
// /tmp on this box is a tiny tmpfs that fills up; Chromium needs temp space
// for shared-memory files, so point it at a roomy dir under ./data unless
// the operator set TMPDIR explicitly.
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = TMP_DIR;

const app = express();
app.use(express.json({ limit: '2mb' }));
// All privileged API endpoints require a bearer token when configured.
// Agent City supplies this token server-side; never expose it to browser JS.
app.use('/api', apiAuth(process.env.BROWSERBRO_TOKEN));
app.use(express.static(path.join(__dirname, 'public')));

// One bad promise must never kill the server.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e && e.message));

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

// ---- session store -------------------------------------------------------
const sessions = new Map(); // id -> {id,name,persistent,profile,context,page,createdAt,recording,recordTimer,framesDir,frameCount,replayPath}
installTerminal(app, sessions); // Per-session agent terminal: real browser commands, no host shell
let counter = 0;
function newId() {
  counter += 1;
  return `sess_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 6)}`;
}
function publicSession(s) {
  return {
    id: s.id, name: s.name, persistent: s.persistent, profile: s.profile,
    url: s.page ? s.page.url() : null, createdAt: s.createdAt,
    recording: !!s.recording, frames: s.frameCount || 0,
    replay: s.replayPath ? path.basename(s.replayPath) : null,
  };
}
// Parse a proxy URL (possibly with credentials) into Playwright's {server, username, password}.
// The sandbox egress proxy is authenticated and MITMs TLS with a custom CA that
// Chromium does not trust, so when a proxy is configured we also pass
// --ignore-certificate-errors unless BROWSERBRO_IGNORE_CERTS=0.
// In a normal deployment (no proxy env) nothing is added.
function parseProxyEnv() {
  const raw = process.env.BROWSERBRO_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!raw) return { proxy: undefined, ignoreCerts: false };
  try {
    const u = new URL(raw);
    const server = `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
    const proxy = { server };
    // Playwright defaults to sending loopback through the proxy (<-loopback),
    // which breaks the local dashboard and test pages. Bypass it.
    proxy.bypass = 'localhost,127.0.0.1';
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    const ignoreCerts = process.env.BROWSERBRO_IGNORE_CERTS !== '0';
    return { proxy, ignoreCerts };
  } catch (e) {
    return { proxy: { server: raw }, ignoreCerts: false };
  }
}
function launchArgs() {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  const { proxy, ignoreCerts } = parseProxyEnv();
  if (ignoreCerts) args.push('--ignore-certificate-errors');
  // Playwright appends `<-loopback` to its own bypass list, which forces
  // loopback through the proxy and breaks local pages. A later
  // --proxy-bypass-list flag wins in Chromium, so set it here explicitly.
  if (proxy) args.push('--proxy-bypass-list=localhost,127.0.0.1');
  return { args, proxy, executablePath: CHROME_PATH || undefined };
}
function getSession(req, res) {
  const s = sessions.get(req.params.id);
  if (!s) { res.status(404).json({ ok: false, error: 'session_not_found', id: req.params.id }); return null; }
  return s;
}

// ---- health / limits -----------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'browserbro', version: '0.1.0', sessions: sessions.size, port: PORT });
});

app.get('/api/limits', (req, res) => {
  res.json({
    ok: true,
    pricing: 'free, $0, no credits, no card, no API key',
    limits: {
      browser: 'local Chromium only, one machine',
      sessions: 'limited by local RAM/CPU only (each session is a real Chrome context)',
      search: 'DuckDuckGo HTML, keyless, rate-limited by DuckDuckGo',
      replay: 'ffmpeg required for MP4 (present in this install)',
      proxy: process.env.BROWSERBRO_PROXY ? 'configured' : 'none (direct)',
    },
  });
});

// A real desktop Chrome UA: some sites (notably search engines) serve an
// empty shell or a bot page to the headless-shell default UA.
const REAL_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// ---- sessions ------------------------------------------------------------
app.post('/api/sessions', async (req, res) => {
  try {
    const name = (req.body && req.body.name) || 'browserbro session';
    const persistent = !!(req.body && req.body.persistent);
    const profile = (req.body && req.body.profile) || (persistent ? `profile_${Date.now().toString(36)}` : null);
    // A caller-controlled profile must never escape the profiles directory.
    if (persistent && (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))) {
      return res.status(400).json({ ok: false, error: 'invalid_profile', message: 'Profile must be 1-64 letters, digits, underscores or hyphens.' });
    }
    const id = newId();
    const { args, proxy, executablePath } = launchArgs();
    let context, page;
    if (persistent) {
      const userDataDir = path.join(PROFILES_DIR, profile);
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: true, args, proxy, executablePath,
        viewport: { width: 1280, height: 800 }, userAgent: REAL_UA,
      });
      page = context.pages()[0] || await context.newPage();
    } else {
      const browser = await chromium.launch({ headless: true, args, proxy, executablePath });
      context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: REAL_UA });
      context._browser = browser;
      page = await context.newPage();
    }
    const s = {
      id, name, persistent, profile, context, page,
      createdAt: new Date().toISOString(), recording: false, frameCount: 0,
      framesDir: path.join(REPLAYS_DIR, id), replayPath: null,
    };
    sessions.set(id, s);
    res.status(201).json({ ok: true, session: publicSession(s) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'session_create_failed', message: String(e.message || e) });
  }
});

app.get('/api/sessions', (req, res) => {
  res.json({ ok: true, sessions: [...sessions.values()].map(publicSession) });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json({ ok: true, session: publicSession(s) });
});

app.delete('/api/sessions/:id', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    if (s.recording) stopRecording(s).catch(() => {});
    await s.context.close();
    if (s.context._browser) await s.context._browser.close().catch(() => {});
  } catch (e) { /* already closed */ }
  sessions.delete(s.id);
  res.json({ ok: true, deleted: s.id, profile_kept: !!s.persistent, profile: s.profile || null });
});

// ---- actions -------------------------------------------------------------
app.post('/api/sessions/:id/navigate', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const url = req.body && req.body.url;
  if (!url) return res.status(400).json({ ok: false, error: 'missing_url' });
  try {
    // domcontentloaded first; some pages hang on a slow subresource through
    // a proxy, so fall back to 'commit' (HTML received) and say so honestly.
    let loadState = 'domcontentloaded';
    try {
      await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      await s.page.goto(url, { waitUntil: 'commit', timeout: 30000 });
      loadState = 'commit';
    }
    res.json({ ok: true, url: s.page.url(), title: await s.page.title(), loadState });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'navigation_failed', url, message: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/click', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const selector = req.body && req.body.selector;
  if (!selector) return res.status(400).json({ ok: false, error: 'missing_selector' });
  try {
    const before = s.page.url();
    await s.page.click(selector, { timeout: 15000 });
    await s.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    res.json({ ok: true, url: s.page.url(), title: await s.page.title(), url_changed: s.page.url() !== before });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'click_failed', selector, message: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/type', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const { selector, text, submit } = req.body || {};
  if (!selector || text === undefined) return res.status(400).json({ ok: false, error: 'missing_selector_or_text' });
  try {
    await s.page.fill(selector, String(text), { timeout: 15000 });
    if (submit) await s.page.keyboard.press('Enter');
    res.json({ ok: true, url: s.page.url() });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'type_failed', selector, message: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/scroll', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const y = (req.body && req.body.y) || 800;
  try {
    await s.page.evaluate((yy) => window.scrollTo(0, yy), y);
    res.json({ ok: true, scrolled_to: y, url: s.page.url() });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'scroll_failed', message: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/wait', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const ms = Math.min(parseInt((req.body && req.body.ms) || '1000', 10) || 1000, 60000);
  await s.page.waitForTimeout(ms);
  res.json({ ok: true, waited_ms: ms, url: s.page.url() });
});

app.post('/api/sessions/:id/evaluate', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const expression = req.body && req.body.expression;
  if (!expression) return res.status(400).json({ ok: false, error: 'missing_expression' });
  try {
    const value = await s.page.evaluate(expression);
    res.json({ ok: true, value: value === undefined ? null : value });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'evaluate_failed', message: String(e.message || e) });
  }
});

// ---- reads ---------------------------------------------------------------
app.get('/api/sessions/:id/url', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json({ ok: true, url: s.page.url() });
});
app.get('/api/sessions/:id/title', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json({ ok: true, title: await s.page.title(), url: s.page.url() });
});
app.get('/api/sessions/:id/text', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const text = await s.page.evaluate(() => document.body ? document.body.innerText : '');
  res.json({ ok: true, url: s.page.url(), text: (text || '').slice(0, 20000) });
});
app.get('/api/sessions/:id/links', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const links = await s.page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({ text: (a.innerText || '').trim().slice(0, 120), href: a.href })));
  res.json({ ok: true, url: s.page.url(), count: links.length, links });
});
app.get('/api/sessions/:id/cookies', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json({ ok: true, cookies: await s.context.cookies() });
});
app.get('/api/sessions/:id/localstorage', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const data = await s.page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
  res.json({ ok: true, localStorage: data });
});

// ---- screenshots / pdf / live view ---------------------------------------
app.get('/api/sessions/:id/screenshot', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const buf = await s.page.screenshot({ type: 'png' });
    res.type('image/png').send(buf);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'screenshot_failed', message: String(e.message || e) });
  }
});
app.get('/api/sessions/:id/live', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const buf = await s.page.screenshot({ type: 'png' });
    res.set('Cache-Control', 'no-store').type('image/png').send(buf);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'live_view_failed', message: String(e.message || e) });
  }
});
app.get('/api/sessions/:id/pdf', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const buf = await s.page.pdf({ format: 'A4' });
    res.type('application/pdf').send(buf);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'pdf_failed', message: String(e.message || e) });
  }
});

// ---- replay --------------------------------------------------------------
async function captureFrame(s) {
  try {
    const n = String(s.frameCount).padStart(4, '0');
    const file = path.join(s.framesDir, `frame${n}.png`);
    await s.page.screenshot({ type: 'png', path: file });
    s.frameCount += 1;
  } catch (e) { /* page may be navigating; skip frame */ }
}
async function stopRecording(s) {
  if (s.recordTimer) { clearInterval(s.recordTimer); s.recordTimer = null; }
  s.recording = false;
  if (!s.frameCount) throw new Error('no frames captured');
  const out = path.join(REPLAYS_DIR, `${s.id}.mp4`);
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-framerate', '2', '-i', path.join(s.framesDir, 'frame%04d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
      (err, stdout, stderr) => err ? reject(new Error(stderr.slice(-500) || err.message)) : resolve());
  });
  s.replayPath = out;
  return out;
}
app.post('/api/sessions/:id/replay/start', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (s.recording) return res.json({ ok: true, recording: true, frames: s.frameCount });
  fs.mkdirSync(s.framesDir, { recursive: true });
  for (const f of fs.readdirSync(s.framesDir)) fs.unlinkSync(path.join(s.framesDir, f));
  s.frameCount = 0; s.replayPath = null; s.recording = true;
  s.recordTimer = setInterval(() => captureFrame(s), 500);
  captureFrame(s);
  res.json({ ok: true, recording: true });
});
app.post('/api/sessions/:id/replay/stop', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (!s.recording) return res.status(400).json({ ok: false, error: 'not_recording' });
  try {
    const out = await stopRecording(s);
    const st = fs.statSync(out);
    res.json({ ok: true, recording: false, frames: s.frameCount, replay: path.basename(out), bytes: st.size });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'replay_failed', message: String(e.message || e) });
  }
});
app.get('/api/sessions/:id/replay', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const file = path.join(REPLAYS_DIR, `${s.id}.mp4`);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'no_replay_yet' });
  res.type('video/mp4').sendFile(file);
});
app.get('/api/sessions/:id/replay/frames', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (!fs.existsSync(s.framesDir)) return res.json({ ok: true, frames: [] });
  res.json({ ok: true, frames: fs.readdirSync(s.framesDir).filter(f => f.endsWith('.png')).sort() });
});

// ---- downloads / uploads -------------------------------------------------
app.post('/api/sessions/:id/download', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const url = req.body && req.body.url;
  if (!url) return res.status(400).json({ ok: false, error: 'missing_url' });
  try {
    // Tried first: a page click (Chrome ignores the `download` attribute
    // cross-origin, so the PDF viewer opens instead), the browser context's
    // request stack (socket hang up through this proxy), and CDP download
    // behavior (no download event fires in headless shell here). What works
    // in this environment is a plain server-side fetch through the same
    // egress proxy, with a desktop UA. The file bytes are real, from the
    // real URL. Limitation, stated honestly: it does not carry the session's
    // cookies, so authenticated same-origin downloads need the page-click
    // path instead.
    const r = await fetch(url, { headers: { 'User-Agent': REAL_UA }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = Buffer.from(await r.arrayBuffer());
    let name = 'download';
    try { name = new URL(url).pathname.split('/').filter(Boolean).pop() || name; } catch {}
    const cd = r.headers.get('content-disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch {} }
    const dest = path.join(DOWNLOADS_DIR, path.basename(name));
    fs.writeFileSync(dest, body);
    res.json({ ok: true, file: path.basename(dest), bytes: body.length, path: dest, via: 'server-fetch' });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'download_failed', url, message: String(e.message || e) });
  }
});
app.get('/api/downloads/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(DOWNLOADS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'file_not_found' });
  res.sendFile(full);
});
app.post('/api/sessions/:id/upload', upload.single('file'), async (req, res) => {
  try {
    const s = getSession(req, res); if (!s) return;
    const selector = req.body && req.body.selector;
    if (!req.file) return res.status(400).json({ ok: false, error: 'missing_file' });
    if (!selector) return res.status(400).json({ ok: false, error: 'missing_selector' });
    // Playwright accepts an in-memory payload, preserving the original filename
    // without copying it to a shared directory where uploads can collide.
    await s.page.setInputFiles(selector, uploadPayload(req.file));
    res.json({ ok: true, uploaded: req.file.originalname, bytes: req.file.size, selector, url: s.page.url() });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'upload_failed', message: String(e.message || e) });
  } finally {
    cleanupUpload(req.file);
  }
});

// Local upload test page (see public/test-upload.html).
app.post('/api/test-upload', upload.single('file-upload'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'missing_file' });
    res.json({ ok: true, file: req.file.originalname, bytes: req.file.size });
  } finally {
    cleanupUpload(req.file);
  }
});

// Multer's size limit is a request error, not an internal server failure.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ ok: false, error: 'upload_limit_exceeded', code: err.code });
  }
  next(err);
});

// ---- search + fetch (free, keyless) ---------------------------------------
// Search runs server-side first: plain fetch of the engine's HTML page with a
async function withTempContext(fn) {
  const { args, proxy, executablePath } = launchArgs();
  const browser = await chromium.launch({ headless: true, args, proxy, executablePath });
  const ctx = await browser.newContext({ userAgent: REAL_UA });
  const page = await ctx.newPage();
  try { return await fn(page); } finally { await ctx.close(); await browser.close().catch(() => {}); }
}
// desktop UA (no API key). DDG first, then Bing. The browser path is the
// last resort: in this sandbox the egress IP gets a 202 "anomaly" page from
// DDG and an empty JS shell from Bing in-browser, while server-side fetch of
// Bing HTML works. All three return real results or an honest 502.
function decodeHtml(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function unwrapBingUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    let enc = u.searchParams.get('u');
    if (enc) {
      // Bing prefixes the base64url target with a 2-char version tag (a1).
      if (/^a\d/.test(enc)) enc = enc.slice(2);
      return Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
  } catch {}
  return href;
}
function unwrapDdgUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const enc = u.searchParams.get('uddg');
    if (enc) return decodeURIComponent(enc);
  } catch {}
  return href;
}
async function fetchHtmlSearch(url, parse) {
  const r = await fetch(url, { headers: { 'User-Agent': REAL_UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) return [];
  const html = await r.text();
  return parse(html).slice(0, 10);
}
function parseDdgHtml(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(html))) out.push({ title: decodeHtml(m[2].replace(/<[^>]+>/g, '')).trim(), url: unwrapDdgUrl(decodeHtml(m[1])) });
  return out;
}
function parseBingHtml(html) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(html))) out.push({ title: decodeHtml(m[2].replace(/<[^>]+>/g, '')).trim(), url: unwrapBingUrl(decodeHtml(m[1])) });
  return out;
}
async function ddgSearch(page, query) {
  const engines = [
    { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, sel: 'a.result__a, a.result-link' },
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, sel: 'a.result__a, a.result-link' },
    { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, sel: '.b_algo h2 a' },
  ];
  for (const e of engines) {
    try {
      await page.goto(e.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const results = await page.evaluate((sel) => {
        const out = [];
        document.querySelectorAll(sel).forEach(a => {
          out.push({ title: (a.innerText || '').trim(), url: a.href });
        });
        return out.slice(0, 10);
      }, e.sel);
      if (results.length) return { engine: new URL(e.url).host, results };
    } catch (err) { /* try next engine */ }
  }
  return { engine: null, results: [] };
}
app.post('/api/search', async (req, res) => {
  const query = req.body && req.body.query;
  if (!query) return res.status(400).json({ ok: false, error: 'missing_query' });
  try {
    // 1) Server-side HTML fetch (fast, works through the sandbox proxy).
    const tries = [
      { host: 'html.duckduckgo.com', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseDdgHtml },
      { host: 'www.bing.com', url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBingHtml },
    ];
    for (const t of tries) {
      try {
        const results = await fetchHtmlSearch(t.url, t.parse);
        if (results.length) return res.json({ ok: true, query, engine: t.host, count: results.length, results });
      } catch (e) { /* next engine */ }
    }
    // 2) Real browser navigation as a last resort.
    const { engine, results } = await withTempContext(page => ddgSearch(page, query));
    if (!results.length) return res.status(502).json({ ok: false, error: 'search_no_results', query, message: 'Search engines returned no results (may be rate-limited)' });
    res.json({ ok: true, query, engine, count: results.length, results });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'search_failed', message: String(e.message || e) });
  }
});
app.post('/api/fetch', async (req, res) => {
  const url = req.body && req.body.url;
  if (!url) return res.status(400).json({ ok: false, error: 'missing_url' });
  try {
    const data = await withTempContext(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return {
        url: page.url(), title: await page.title(),
        text: (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 20000),
      };
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'fetch_failed', url, message: String(e.message || e) });
  }
});

// ---- fallback errors ------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'unknown_api_route', path: req.path }));

app.listen(PORT, HOST, () => {
  console.log(`browserbro listening on http://${HOST}:${PORT}`);
  console.log('health: GET /api/health | dashboard: /');
});
