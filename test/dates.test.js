import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, formatDay, gasDayTimestamp, parseDay, today } from '../src/dates.js';

test('formatDay renders a UTC day', () => {
  assert.equal(formatDay(new Date('2026-02-03T22:15:00.000Z')), '2026-02-03');
});

test('parseDay rejects anything that is not a YYYY-MM-DD day', () => {
  assert.equal(parseDay('2026-02-03')?.toISOString(), '2026-02-03T00:00:00.000Z');
  assert.equal(parseDay('03/02/2026'), undefined);
  assert.equal(parseDay(''), undefined);
  assert.equal(parseDay(undefined), undefined);
});

test('addDays walks the calendar in both directions, across months', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('addDays crosses a leap day', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
});

test('a gas day is timestamped inside its own calendar day, in French time', () => {
  const timestamp = gasDayTimestamp('2026-02-03');
  assert.equal(timestamp.toISOString(), '2026-02-03T12:00:00.000Z');
  // Winter (UTC+1) and summer (UTC+2) alike, noon UTC stays the same day.
  const inParis = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }).format(timestamp);
  assert.equal(inParis, '03/02/2026');
  const summer = gasDayTimestamp('2026-07-15');
  assert.equal(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }).format(summer),
    '15/07/2026',
  );
});

test('gasDayTimestamp refuses a day it cannot parse', () => {
  assert.throws(() => gasDayTimestamp('not-a-day'), TypeError);
});

test('today is injectable so the tests never depend on the clock', () => {
  assert.equal(today(new Date('2026-08-07T09:30:00.000Z')), '2026-08-07');
});
