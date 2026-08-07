import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, parsePceList } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps the user values over the defaults', () => {
  const config = normalizeConfig({
    email: 'user@example.com',
    password: 'secret',
    history_days: 30,
    poll_frequency: 43200,
  });
  assert.equal(config.email, 'user@example.com');
  assert.equal(config.password, 'secret');
  assert.equal(config.history_days, 30);
  assert.equal(config.poll_frequency, 43200);
});

test('normalizeConfig trims the email (a copy/paste often carries a space)', () => {
  assert.equal(normalizeConfig({ email: '  user@example.com ' }).email, 'user@example.com');
});

test('normalizeConfig coerces the numbers coming from the form as strings', () => {
  const config = normalizeConfig({ history_days: '15', poll_frequency: '7200' });
  assert.equal(config.history_days, 15);
  assert.equal(config.poll_frequency, 7200);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig clamps the numbers to the range of the manifest', () => {
  const tooSmall = normalizeConfig({ history_days: 0, poll_frequency: 5 });
  assert.equal(tooSmall.history_days, 1);
  assert.equal(tooSmall.poll_frequency, 3600);

  const tooBig = normalizeConfig({ history_days: 99999, poll_frequency: 999999 });
  assert.equal(tooBig.history_days, 1095);
  assert.equal(tooBig.poll_frequency, 86400);
});

test('normalizeConfig falls back to the default for an unusable number', () => {
  const config = normalizeConfig({ history_days: 'not a number', poll_frequency: null });
  assert.equal(config.history_days, DEFAULT_CONFIG.history_days);
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('parsePceList accepts every separator a user may type', () => {
  assert.deepEqual(parsePceList('01234567890123, 98765432109876'), [
    '01234567890123',
    '98765432109876',
  ]);
  assert.deepEqual(parsePceList('01234567890123;98765432109876'), [
    '01234567890123',
    '98765432109876',
  ]);
  assert.deepEqual(parsePceList('01234567890123\n98765432109876'), [
    '01234567890123',
    '98765432109876',
  ]);
});

test('parsePceList returns an empty list when nothing is configured', () => {
  assert.deepEqual(parsePceList(''), []);
  assert.deepEqual(parsePceList('   '), []);
  assert.deepEqual(parsePceList(undefined), []);
});

test('isConfigured requires both an email and a password', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ email: 'user@example.com' })), false);
  assert.equal(isConfigured(normalizeConfig({ password: 'secret' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ email: 'user@example.com', password: 'secret' })),
    true,
  );
});
