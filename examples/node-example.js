// browserbro Node example: drive a real Chrome session via the REST API.
// Run: node examples/node-example.js   (server must be running: npm start)
const BASE = process.env.BROWSERBRO_URL || 'http://localhost:3101';

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

(async () => {
  const health = await api('/api/health');
  console.log('health:', health.body);

  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'node-example' }) });
  const id = created.body.session.id;
  console.log('session:', id);

  const nav = await api(`/api/sessions/${id}/navigate`, { method: 'POST', body: JSON.stringify({ url: 'https://news.ycombinator.com' }) });
  console.log('navigated:', nav.body.title, nav.body.url);

  const title = await api(`/api/sessions/${id}/title`);
  console.log('title:', title.body.title);

  const links = await api(`/api/sessions/${id}/links`);
  console.log('first link:', links.body.links[0]);

  // Screenshot to a file
  const shot = await fetch(`${BASE}/api/sessions/${id}/screenshot`);
  const buf = Buffer.from(await shot.arrayBuffer());
  require('fs').writeFileSync('hn-node-example.png', buf);
  console.log('screenshot saved: hn-node-example.png', buf.length, 'bytes');

  const del = await api(`/api/sessions/${id}`, { method: 'DELETE' });
  console.log('deleted:', del.body);
})().catch((e) => { console.error(e); process.exit(1); });
