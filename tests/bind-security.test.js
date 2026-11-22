const test = require('node:test');
const assert = require('node:assert/strict');
const { isLoopback, assertSafeBind } = require('../bind-security');
test('only loopback addresses are trusted without authentication', () => {
  for (const h of ['127.0.0.1', '127.12.4.3', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopback(h), true, h);
    assert.doesNotThrow(() => assertSafeBind(h, ''));
  }
  for (const h of ['0.0.0.0', '::', '192.168.1.2', 'example.com', '']) {
    assert.equal(isLoopback(h), false, h);
    assert.throws(() => assertSafeBind(h, ''), /BROWSERBRO_TOKEN/);
    assert.doesNotThrow(() => assertSafeBind(h, 'strong-test-token'));
  }
});
