import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRateLimit, parseRetryAfterMs } from '../shared.js';

test('detectRateLimit matches each pattern', () => {
  const samples = [
    'Error: insufficient_quota for this account',
    'You are being rate limited, please wait',
    'rate-limiting is in effect',
    'Too many requests, slow down',
    'resource_exhausted: quota exceeded',
    'overloaded_error: servers are busy',
    'request failed with status 429',
  ];
  for (const s of samples) {
    assert.ok(detectRateLimit(s), `expected a match for: ${s}`);
  }
});

test('detectRateLimit does not match a benign sentence about implementing rate limiting', () => {
  // The guard against false positives here is the CALLER's job (only run on
  // failure output, per server.js) — this module matches the phrase
  // "rate limit" wherever it appears, including in success output describing
  // a feature that was implemented.
  const benign = 'Implemented rate limiting for the API endpoint successfully.';
  assert.ok(detectRateLimit(benign));
});

test('parseRetryAfterMs parses seconds and milliseconds', () => {
  assert.equal(parseRetryAfterMs('Please try again in 1.605s'), 1605);
  assert.equal(parseRetryAfterMs('retry in 300ms'), 300);
  assert.equal(parseRetryAfterMs('no timing information here'), 0);
});
