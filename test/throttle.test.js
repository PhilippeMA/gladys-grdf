import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_POLL_INTERVAL_MS, Throttle } from '../src/throttle.js';

const START = Date.parse('2026-08-07T09:00:00.000Z');

test('the first run of a key is always allowed', () => {
  const throttle = new Throttle();
  assert.equal(throttle.allow('pce', START), true);
});

test('a second run too soon is refused', () => {
  const throttle = new Throttle();
  throttle.allow('pce', START);
  assert.equal(throttle.allow('pce', START + 60_000), false);
});

test('a run is allowed again once the interval has passed', () => {
  const throttle = new Throttle();
  throttle.allow('pce', START);
  assert.equal(throttle.allow('pce', START + MIN_POLL_INTERVAL_MS), true);
});

test('each key has its own budget', () => {
  const throttle = new Throttle();
  assert.equal(throttle.allow('a', START), true);
  assert.equal(throttle.allow('b', START), true);
  assert.equal(throttle.allow('a', START), false);
});

test('the interval is configurable', () => {
  const throttle = new Throttle(1000);
  throttle.allow('pce', START);
  assert.equal(throttle.allow('pce', START + 999), false);
  assert.equal(throttle.allow('pce', START + 1000), true);
});

test('reset gives a key its next run back', () => {
  const throttle = new Throttle();
  throttle.allow('pce', START);
  throttle.reset('pce');
  assert.equal(throttle.allow('pce', START), true);
});

test('the default floor stays well below the daily publication rhythm', () => {
  assert.ok(MIN_POLL_INTERVAL_MS < 24 * 3600 * 1000);
  assert.ok(MIN_POLL_INTERVAL_MS >= 5 * 60 * 1000);
});
