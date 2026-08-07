import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCreatedDevice, hasAnyValue } from '../src/created.js';

test('findCreatedDevice matches on the external id', () => {
  const devices = [{ external_id: 'ext:grdf:gazpar:1' }, { external_id: 'ext:grdf:gazpar:2' }];
  assert.deepEqual(findCreatedDevice(devices, 'ext:grdf:gazpar:2'), {
    external_id: 'ext:grdf:gazpar:2',
  });
});

test('a meter absent from the created devices is not found', () => {
  assert.equal(findCreatedDevice([{ external_id: 'other' }], 'ext:grdf:gazpar:1'), undefined);
  assert.equal(findCreatedDevice([], 'ext:grdf:gazpar:1'), undefined);
});

test('findCreatedDevice survives a payload that is not a list', () => {
  assert.equal(findCreatedDevice(undefined, 'x'), undefined);
  assert.equal(findCreatedDevice(null, 'x'), undefined);
  assert.equal(findCreatedDevice({ nope: true }, 'x'), undefined);
});

test('hasAnyValue is true as soon as one feature holds something', () => {
  assert.equal(hasAnyValue({ features: [{ last_value: null }, { last_value: 0 }] }), true);
  assert.equal(hasAnyValue({ features: [{ last_value_string: 'ok' }] }), true);
});

test('a value of zero counts: a day without gas is data', () => {
  assert.equal(hasAnyValue({ features: [{ last_value: 0 }] }), true);
});

test('hasAnyValue is false for a device that never received anything', () => {
  assert.equal(hasAnyValue({ features: [{ last_value: null }, { last_value: undefined }] }), false);
  assert.equal(hasAnyValue({ features: [{}] }), false);
  assert.equal(hasAnyValue({ features: [] }), false);
  assert.equal(hasAnyValue({}), false);
  assert.equal(hasAnyValue(undefined), false);
});
