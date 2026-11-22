'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual proxy and Chromium launch helpers without starting a server
// or requiring a browser download.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function parseProxyEnv() {');
const end = source.indexOf('function getSession(req, res) {', start);
assert.ok(start >= 0 && end > start, 'proxy launch helpers must exist');
const helpers = source.slice(start, end);
function launchWith(env) {
  const context = { process: { env }, URL, CHROME_PATH: null };
  vm.runInNewContext(helpers + '\nresult = launchArgs();', context);
  return context.result;
}
test('direct browsing keeps certificate validation enabled', () => {
  const result = launchWith({});
  assert.equal(result.args.includes('--ignore-certificate-errors'), false);
});
test('proxy browsing keeps certificate validation enabled by default', () => {
  const result = launchWith({ HTTPS_PROXY: 'http://proxy.example:8080' });
  assert.equal(result.args.includes('--ignore-certificate-errors'), false);
  assert.equal(result.proxy.server, 'http://proxy.example:8080');
});
test('only explicit opt-in bypasses certificate validation', () => {
  for (const value of ['0', 'true', 'yes', '']) {
    const result = launchWith({ BROWSERBRO_PROXY: 'http://proxy.example:8080', BROWSERBRO_IGNORE_CERTS: value });
    assert.equal(result.args.includes('--ignore-certificate-errors'), false, value);
  }
  const optedIn = launchWith({ BROWSERBRO_PROXY: 'http://proxy.example:8080', BROWSERBRO_IGNORE_CERTS: '1' });
  assert.equal(optedIn.args.includes('--ignore-certificate-errors'), true);
});
test('explicit opt-in without a proxy does not bypass validation', () => {
  const result = launchWith({ BROWSERBRO_IGNORE_CERTS: '1' });
  assert.equal(result.args.includes('--ignore-certificate-errors'), false);
});
