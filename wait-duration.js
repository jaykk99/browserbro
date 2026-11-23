'use strict';
// Reject malformed, negative and fractional durations before calling Playwright.
function parseWaitDuration(value) {
  if (value === undefined || value === null) return 1000;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return Math.min(n, 60000);
}
module.exports = { parseWaitDuration };
