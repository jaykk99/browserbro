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

// ---- Monico buyer codes (BrowserBro Pro) ---------------------------------
// A hosted BrowserBro can sell access through the Monico Labs shop instead of
// sharing one operator token: the buyer pays in crypto, gets an access code,
// and presents it as `X-Access-Code` (or `?code=`). Codes are verified
// against the Monico hub's /api/auth/code endpoint — the same endpoint the
// Code Runner Pro unlock calls — and only a grant naming product
// "browserbro" opens the API. Nothing is unlocked on a format guess or when
// the hub cannot be reached. Buyer-code auth is opt-in: it only runs when
// BROWSERBRO_HUB_URL is set. With neither a token nor a hub URL configured,
// the API stays open exactly as before (local-only default).

const HUB_CODE_TTL_MS = 15 * 60 * 1000; // verified codes are cached 15 min

// Same normalisation the hub applies (hub-worker/src/crypto.js) and
// Code Runner uses: case, spaces, dashes, and the Crockford look-alikes
// (O->0, I/L->1). Returns the canonical "ML-XXXX-XXXX-XXXX-XXXX" form, or
// null when the input cannot be a real code.
function normalizeAccessCode(code) {
  let s = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  if (s.indexOf('ML') === 0) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(s)) return null;
  return 'ML-' + s.match(/.{4}/g).join('-');
}

// Verify one access code against the hub. Returns the grants array.
// Throws an Error with a .status: 401 bad code, 429 hub rate-limited,
// 502 hub answered oddly, 503 hub unreachable. fetchImpl is injectable
// for tests; cache is a Map(code -> {grants, expiresAt}).
async function verifyBuyerCode(code, { hubUrl, fetchImpl, cache } = {}) {
  const normalized = normalizeAccessCode(code);
  if (!normalized) {
    const e = new Error('that access code is not valid');
    e.status = 401;
    throw e;
  }
  const store = cache || new Map();
  const hit = store.get(normalized);
  if (hit && hit.expiresAt > Date.now()) return hit.grants;
  const hub = String(hubUrl || '').replace(/\/$/, '');
  let res;
  try {
    res = await (fetchImpl || fetch)(hub + '/api/auth/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalized }),
      signal: AbortSignal.timeout(60000), // Render free hubs can take ~20s to wake
    });
  } catch (err) {
    const e = new Error('the shop could not be reached — try again in a bit');
    e.status = 503;
    e.cause = err;
    throw e;
  }
  if (res.status === 401) {
    const e = new Error('that access code is not valid');
    e.status = 401;
    throw e;
  }
  if (res.status === 429) {
    const e = new Error('too many code checks — wait 15 minutes');
    e.status = 429;
    throw e;
  }
  if (!res.ok) {
    const e = new Error('the shop answered HTTP ' + res.status + ' — try again in a bit');
    e.status = 502;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  const grants = (data && data.grants) || [];
  store.set(normalized, { grants, expiresAt: Date.now() + HUB_CODE_TTL_MS });
  return grants;
}

function buyerCodeAuth(hubUrl, opts = {}) {
  const hub = String(hubUrl || '').trim();
  if (!hub) return (_req, _res, next) => next();
  const cache = opts.cache || new Map();
  return async (req, res, next) => {
    const raw = req.get('x-access-code') || req.query.code;
    if (!raw) {
      res.status(401).json({ ok: false, error: 'access_code_required', message: 'Send your Monico access code as X-Access-Code (or ?code=).' });
      return;
    }
    let grants;
    try {
      grants = await verifyBuyerCode(raw, { hubUrl: hub, fetchImpl: opts.fetchImpl, cache });
    } catch (err) {
      res.status(err.status || 503).json({ ok: false, error: 'access_code_check_failed', message: err.message });
      return;
    }
    const mine = grants.find((g) => g && g.product === 'browserbro');
    if (!mine) {
      res.status(403).json({ ok: false, error: 'access_code_no_browserbro', message: 'That code is real, but it does not include BrowserBro.' });
      return;
    }
    req.buyerCodeTier = mine.tier || '';
    next();
  };
}

// Accept EITHER the operator bearer token OR a Monico buyer code.
// When neither is configured, the API stays open (local-only default).
function anyAuth(token, hubUrl, opts = {}) {
  const tokenGate = apiAuth(token);
  const codeGate = buyerCodeAuth(hubUrl, opts);
  const tokenConfigured = String(token || '').trim() !== '';
  const hubConfigured = String(hubUrl || '').trim() !== '';
  if (!tokenConfigured && !hubConfigured) return (_req, _res, next) => next();
  const expected = tokenConfigured
    ? createHash('sha256').update(String(token).trim()).digest()
    : null;
  return async (req, res, next) => {
    // Operator token first: no hub round-trip for the city's own calls.
    if (expected) {
      const match = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
      const given = match && match[1];
      if (given) {
        const digest = createHash('sha256').update(given).digest();
        if (timingSafeEqual(expected, digest)) return next();
      }
    }
    if (hubConfigured) return codeGate(req, res, next);
    // Token configured (and wrong/missing) with no hub fallback.
    tokenGate(req, res, next);
  };
}

module.exports = { apiAuth, normalizeAccessCode, verifyBuyerCode, buyerCodeAuth, anyAuth };
