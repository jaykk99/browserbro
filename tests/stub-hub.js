// Stub Monico hub for local gate testing ONLY. Implements just
// POST /api/auth/code with the same contract as the real hub:
//   ML-2345-6789-ABCD-EFGH -> grant for product "browserbro" (pro)
//   ML-1111-2222-3333-4444 -> grant for product "code-runner" (pro)
//   anything else -> 401 {error: "that access code is not valid"}
// Listens on 127.0.0.1:3299. Never used in production.
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/auth/code') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let code = '';
    try { code = JSON.parse(body).code || ''; } catch {}
    if (code === 'ML-2345-6789-ABCD-EFGH') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'stub-token', grants: [{ product: 'browserbro', tier: 'pro' }] }));
    } else if (code === 'ML-1111-2222-3333-4444') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'stub-token', grants: [{ product: 'code-runner', tier: 'pro' }] }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'that access code is not valid', code: 'BAD_CODE' }));
    }
  });
});
server.listen(3299, '127.0.0.1', () => console.log('stub hub listening on 127.0.0.1:3299'));
