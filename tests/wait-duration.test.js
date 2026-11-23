'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWaitDuration } = require('../wait-duration');
test('wait duration defaults and clamps safely', () => {
  assert.equal(parseWaitDuration(undefined), 1000);
  assert.equal(parseWaitDuration(null), 1000);
  assert.equal(parseWaitDuration(0), 0);
  assert.equal(parseWaitDuration('250'), 250);
  assert.equal(parseWaitDuration(60001), 60000);
});
test('invalid wait duration is rejected', () => {
  for (const v of [-1, '-1', '1.5', 1.5, '1abc', 'NaN', '', {}, [], Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseWaitDuration(v), null, String(v));
  }
});
