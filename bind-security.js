'use strict';
const net = require('node:net');
function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (net.isIP(h) === 4) return h.startsWith('127.');
  if (net.isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}
function assertSafeBind(host, token) {
  if (!isLoopback(host) && !String(token || '').trim()) {
    throw new Error('Refusing non-loopback BrowserBro listener without BROWSERBRO_TOKEN; configure a strong token or bind to 127.0.0.1');
  }
}
module.exports = { isLoopback, assertSafeBind };
