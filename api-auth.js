// Optional bearer auth for BrowserBro's privileged HTTP API.
// Keep service loopback-only even with auth unless it is behind HTTPS.
const { createHash, timingSafeEqual } = require('node:crypto');

function apiAuth(token) {
  const configured = String(token || '').trim();
  if (!configured) return (_req, _res, next) => next();
  const expected = createHash('sha256').update(configured).digest();
  return (req, res, next) => {
    const match = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
    const given = match && match[1];
    const digest = createHash('sha256').update(given || '').digest();
    if (!given || !timingSafeEqual(expected, digest)) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    next();
  };
}
module.exports = { apiAuth };
