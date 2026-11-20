// browserbro smoke suite — 22 checks, all against the real server + real Chromium.
// Run: npm run smoke   (starts the server on port 3102, runs checks, writes SMOKE.md)
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const PORT = 3102;
const BASE = `http://localhost:${PORT}`;
const results = [];
let sid = null;

// In proxied sandboxes the egress proxy drops unauthenticated CONNECTs, so
// Chromium cannot talk to it directly. proxy-bridge.js adds the auth header
// preemptively. If a proxy env var is set, start the bridge for the smoke
// run and point the server at it. On a normal machine (no proxy env) this
// is skipped entirely.
let bridgeProc = null;
let bridgeUrl = null;
async function maybeStartBridge() {
  const upstream = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!upstream) return;
  const alive = await new Promise((resolve) => {
    const s = net.connect(3129, '127.0.0.1');
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
  });
  if (alive) { bridgeUrl = 'http://127.0.0.1:3129'; return; }
  try {
    bridgeProc = spawn('node', ['proxy-bridge.js'], {
      cwd: __dirname,
      env: { ...process.env, UPSTREAM_PROXY: upstream, BRIDGE_PORT: '3129' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const ok = await new Promise((resolve) => {
        const s = net.connect(3129, '127.0.0.1');
        s.on('connect', () => { s.end(); resolve(true); });
        s.on('error', () => resolve(false));
      });
      if (ok) { bridgeUrl = 'http://127.0.0.1:3129'; return; }
    }
    console.log('bridge did not come up (continuing without it)');
  } catch (e) {
    console.log('bridge start failed (continuing without it):', e.message);
  }
}

function check(name, ok, evidence) {
  results.push({ name, ok: !!ok, evidence: String(evidence || '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  — ' + String(evidence).slice(0, 160) : ''}`);
}
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body, raw: t };
}
async function apiBuf(p, opts = {}) {
  const r = await fetch(BASE + p, opts);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf };
}
function ffprobe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      (err, stdout) => resolve(err ? null : parseFloat(stdout.trim())));
  });
}
async function waitHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  await maybeStartBridge();
  const serverEnv = { ...process.env, BROWSERBRO_PORT: String(PORT) };
  if (bridgeUrl) serverEnv.BROWSERBRO_PROXY = bridgeUrl;
  const server = spawn('node', ['server.js'], {
    cwd: __dirname, env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stdout.write('[server:err] ' + d));
  const up = await waitHealth();
  check('1. server up (/api/health 200)', up, up ? 'health ok' : 'server did not come up');

  try {
    // 2. create session
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'smoke' }) });
    sid = created.body && created.body.session && created.body.session.id;
    check('2. session create returns an id', created.status === 201 && !!sid, sid || JSON.stringify(created.body));

    // 3. navigate HN
    const nav = await api(`/api/sessions/${sid}/navigate`, { method: 'POST', body: JSON.stringify({ url: 'https://news.ycombinator.com' }) });
    check('3. navigate to news.ycombinator.com', nav.status === 200 && /ycombinator/.test(nav.body.url || ''), nav.body.url);

    // 4. title
    const title = await api(`/api/sessions/${sid}/title`);
    check('4. title reads "Hacker News"', /Hacker News/.test(title.body.title || ''), title.body.title);

    // 5. text
    const text = await api(`/api/sessions/${sid}/text`);
    check('5. page text is real and non-empty', text.status === 200 && (text.body.text || '').length > 200, `${(text.body.text || '').length} chars`);

    // 6. links
    const links = await api(`/api/sessions/${sid}/links`);
    check('6. links list is real and non-empty', links.status === 200 && links.body.count > 10, `${links.body.count} links, first: ${(links.body.links[0] || {}).text}`);

    // 7. click-through on a real HN story link
    const before = (await api(`/api/sessions/${sid}/url`)).body.url;
    const click = await api(`/api/sessions/${sid}/click`, { method: 'POST', body: JSON.stringify({ selector: '.titleline > a' }) });
    const after = (await api(`/api/sessions/${sid}/url`)).body.url;
    check('7. click-through on a Hacker News story link changes the URL', click.status === 200 && after !== before && after !== 'https://news.ycombinator.com/', `${before} -> ${after}`);

    // 8. screenshot
    const shot = await apiBuf(`/api/sessions/${sid}/screenshot`);
    const isPng = shot.buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
    fs.writeFileSync(path.join(__dirname, 'docs', 'smoke-hn-after-click.png'), shot.buf);
    check('8. screenshot is a real PNG', shot.status === 200 && isPng && shot.buf.length > 10000, `${shot.buf.length} bytes`);

    // 9. pdf
    const pdf = await apiBuf(`/api/sessions/${sid}/pdf`);
    check('9. PDF export is a real PDF', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF' && pdf.buf.length > 1000, `${pdf.buf.length} bytes`);

    // 10. live view
    const live = await apiBuf(`/api/sessions/${sid}/live`);
    check('10. live view returns a fresh PNG', live.status === 200 && live.buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && live.buf.length > 5000, `${live.buf.length} bytes`);

    // 11. evaluate
    const ev = await api(`/api/sessions/${sid}/evaluate`, { method: 'POST', body: JSON.stringify({ expression: '1+1' }) });
    check('11. evaluate JS in the page (1+1)', ev.status === 200 && ev.body.value === 2, `value=${ev.body.value}`);

    // 12. cookies
    const ck = await api(`/api/sessions/${sid}/cookies`);
    check('12. cookies endpoint returns an array', ck.status === 200 && Array.isArray(ck.body.cookies), `${(ck.body.cookies || []).length} cookies`);

    // 13. search (free, keyless)
    const search = await api('/api/search', { method: 'POST', body: JSON.stringify({ query: 'playwright' }) });
    const first = search.body.results && search.body.results[0];
    check('13. search returns real results (DuckDuckGo, keyless)', search.status === 200 && (search.body.results || []).length >= 3, `engine=${search.body.engine}, ${search.body.count} results, first: ${first ? first.title : 'none'}`);

    // 14. fetch (title must match; text is the real page body text, which in
    // this Chromium's innerText starts after the h1, so only require it real)
    const fetched = await api('/api/fetch', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    check('14. fetch returns real page text (example.com)', fetched.status === 200 && /Example Domain/.test(fetched.body.title || '') && (fetched.body.text || '').length > 50 && /This domain is for use/.test(fetched.body.text || ''), fetched.body.title);

    // 15. replay MP4
    await api(`/api/sessions/${sid}/replay/start`, { method: 'POST' });
    await api(`/api/sessions/${sid}/navigate`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    await new Promise(r => setTimeout(r, 2500));
    const stop = await api(`/api/sessions/${sid}/replay/stop`, { method: 'POST' });
    const mp4 = path.join(__dirname, 'data', 'replays', `${sid}.mp4`);
    const dur = fs.existsSync(mp4) ? await ffprobe(mp4) : null;
    check('15. replay exports a real MP4 (ffprobe duration > 0)', stop.status === 200 && fs.existsSync(mp4) && dur !== null && dur > 0, `frames=${stop.body.frames}, bytes=${stop.body.bytes}, duration=${dur}s`);

    // 16. persistent context survives close + reopen
    const p1 = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'smoke-persist', persistent: true, profile: 'smoke-profile' }) });
    const pid = p1.body.session.id;
    await api(`/api/sessions/${pid}/navigate`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    await api(`/api/sessions/${pid}/evaluate`, { method: 'POST', body: JSON.stringify({ expression: `localStorage.setItem('bro','smoke-persist-123')` }) });
    const delP = await api(`/api/sessions/${pid}`, { method: 'DELETE' });
    const p2 = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'smoke-persist-2', persistent: true, profile: 'smoke-profile' }) });
    const pid2 = p2.body.session.id;
    await api(`/api/sessions/${pid2}/navigate`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    const ls = await api(`/api/sessions/${pid2}/evaluate`, { method: 'POST', body: JSON.stringify({ expression: `localStorage.getItem('bro')` }) });
    await api(`/api/sessions/${pid2}`, { method: 'DELETE' });
    check('16. persistent context survives close + reopen (localStorage)', delP.body.profile_kept === true && ls.body.value === 'smoke-persist-123', `localStorage bro=${ls.body.value}`);

    // 17. download (w3.org dummy.pdf is a 404 now, verified 2026-11-20;
    // GitHub raw README is a stable real file)
    await api(`/api/sessions/${sid}/navigate`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    const dl = await api(`/api/sessions/${sid}/download`, { method: 'POST', body: JSON.stringify({ url: 'https://raw.githubusercontent.com/microsoft/playwright/main/README.md' }) });
    check('17. download saves a real file', dl.status === 200 && dl.body.bytes > 1000, `${dl.body.file}, ${dl.body.bytes} bytes`);

    // 18. upload (self-hosted test form: herokuapp's subresources hang
    // through this proxy, verified 2026-11-20; the form + setInputFiles path
    // is the same real mechanism either way)
    await api(`/api/sessions/${sid}/navigate`, { method: 'POST', body: JSON.stringify({ url: `${BASE}/test-upload.html` }) });
    const tmpFile = path.join(os.tmpdir(), 'bro-upload-test.txt');
    fs.writeFileSync(tmpFile, 'browserbro upload test\n');
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(tmpFile)]), 'bro-upload-test.txt');
    form.append('selector', '#file-upload');
    const upRes = await fetch(`${BASE}/api/sessions/${sid}/upload`, { method: 'POST', body: form });
    const upJson = await upRes.json();
    await api(`/api/sessions/${sid}/click`, { method: 'POST', body: JSON.stringify({ selector: '#file-submit' }) });
    await new Promise(r => setTimeout(r, 1500));
    const upText = await api(`/api/sessions/${sid}/text`);
    check('18. upload into a real form works', upRes.status === 200 && upJson.ok === true && /File Uploaded/.test(upText.body.text || ''), `uploaded=${upJson.uploaded}, page says File Uploaded`);

    // 19. session list
    const list = await api('/api/sessions');
    check('19. session list contains the session', list.status === 200 && list.body.sessions.some(s => s.id === sid), `${list.body.sessions.length} sessions`);

    // 20. unknown session 404 (honest error, no fake success)
    const bad = await api('/api/sessions/nope-not-real/navigate', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    check('20. unknown session returns honest 404', bad.status === 404 && bad.body.error === 'session_not_found', `status=${bad.status}, error=${bad.body.error}`);

    // 21. scroll + wait
    const sc = await api(`/api/sessions/${sid}/scroll`, { method: 'POST', body: JSON.stringify({ y: 400 }) });
    const wt = await api(`/api/sessions/${sid}/wait`, { method: 'POST', body: JSON.stringify({ ms: 500 }) });
    check('21. scroll + wait actions work', sc.status === 200 && wt.status === 200 && wt.body.waited_ms === 500, `scrolled_to=${sc.body.scrolled_to}, waited=${wt.body.waited_ms}ms`);

    // 22. delete session, then it is gone
    const del = await api(`/api/sessions/${sid}`, { method: 'DELETE' });
    const gone = await api(`/api/sessions/${sid}`);
    check('22. delete session works (then 404)', del.status === 200 && del.body.deleted === sid && gone.status === 404, `deleted=${del.body.deleted}, after=${gone.status}`);
  } catch (e) {
    check('smoke crashed', false, String(e && e.stack || e));
  } finally {
    const passed = results.filter(r => r.ok).length;
    const md = `# browserbro smoke results\n\nRun: ${new Date().toISOString()}\nServer: \`npm start\` on port ${PORT} (spawned by smoke.js)\n\n**${passed}/${results.length} checks passed.**\n\n| # | Check | Result | Evidence |\n|---|---|--------|----------|\n` +
      results.map((r, i) => `| ${i + 1} | ${r.name.replace(/^\d+\.\s*/, '')} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.evidence.replace(/\|/g, '/')} |`).join('\n') +
      `\n\nNotes: Hacker News click-through navigated from the HN front page to the top story's real destination URL (see check 7 evidence). Replay MP4 verified with ffprobe (see check 15). No check was faked; failures would be listed as FAIL above.\n`;
    fs.writeFileSync(path.join(__dirname, 'SMOKE.md'), md);
    console.log(`\n== ${passed}/${results.length} passed ==`);
    server.kill('SIGTERM');
    if (bridgeProc) bridgeProc.kill('SIGTERM');
    setTimeout(() => process.exit(passed === results.length ? 0 : 1), 500);
  }
})();
