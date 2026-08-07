import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_TYPE,
  FEATURE,
  buildDevice,
  buildDeviceName,
  buildStates,
} from '../src/devices/gasMeter.js';
import { buildDiscoveredDevices, filterPces, findPceByExternalId } from '../src/devices/index.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const PCE = '01234567890123';

test('the device declares no poll_frequency: the core only accepts LAN-speed values', () => {
  // DEVICE_POLL_FREQUENCIES, in milliseconds, tops out at one minute — the
  // integration schedules its own refresh instead. Publishing a value outside
  // that list is rejected with "invalid poll frequency".
  const device = buildDevice(createFakeGladys(), { pce: PCE });
  assert.equal(device.poll_frequency, undefined);
});

test('a meter becomes one device carrying four read-only sensors', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, { pce: PCE, alias: 'Maison' });

  assert.equal(device.external_id, `${DEVICE_TYPE}:${PCE}`);
  assert.deepEqual(
    device.features.map((feature) => feature.external_id),
    [
      `${DEVICE_TYPE}:${PCE}:${FEATURE.DAILY_ENERGY}`,
      `${DEVICE_TYPE}:${PCE}:${FEATURE.DAILY_VOLUME}`,
      `${DEVICE_TYPE}:${PCE}:${FEATURE.INDEX}`,
      `${DEVICE_TYPE}:${PCE}:${FEATURE.TEMPERATURE}`,
    ],
  );
  for (const feature of device.features) {
    assert.equal(feature.read_only, true, `${feature.name} must stay read-only`);
    assert.equal(feature.keep_history, true, `${feature.name} must keep its history`);
    assert.ok(feature.category, `${feature.name} needs a category`);
    assert.ok(feature.type, `${feature.name} needs a type`);
    assert.ok(feature.unit, `${feature.name} needs a unit`);
  }
});

test('the device name uses the alias set in Mon Espace, or the PCE number', () => {
  assert.equal(buildDeviceName({ pce: PCE, alias: 'Maison' }), 'Gazpar Maison');
  assert.equal(buildDeviceName({ pce: PCE, alias: '   ' }), `Gazpar ${PCE}`);
  assert.equal(buildDeviceName({ pce: PCE }), `Gazpar ${PCE}`);
});

test('one device is discovered per metering point', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, [{ pce: PCE }, { pce: '98765432109876' }]);
  assert.deepEqual(
    devices.map((device) => device.external_id),
    [`${DEVICE_TYPE}:${PCE}`, `${DEVICE_TYPE}:98765432109876`],
  );
});

test('filterPces keeps everything when the user configured no filter', () => {
  const entries = [{ pce: PCE }, { pce: '98765432109876' }];
  assert.deepEqual(filterPces(entries, ''), entries);
  assert.deepEqual(filterPces(entries, '   '), entries);
});

test('filterPces keeps only the metering points the user listed', () => {
  const entries = [{ pce: PCE }, { pce: '98765432109876' }];
  assert.deepEqual(filterPces(entries, '98765432109876'), [{ pce: '98765432109876' }]);
  assert.deepEqual(filterPces(entries, `${PCE}, 98765432109876`), entries);
  assert.deepEqual(filterPces(entries, '00000000000000'), []);
});

test('a Gladys device is routed back to its metering point', () => {
  const gladys = createFakeGladys();
  const entries = [{ pce: PCE }, { pce: '98765432109876' }];
  assert.deepEqual(findPceByExternalId(gladys, entries, `${DEVICE_TYPE}:98765432109876`), {
    pce: '98765432109876',
  });
  assert.equal(findPceByExternalId(gladys, entries, `${DEVICE_TYPE}:unknown`), undefined);
});

test('buildStates timestamps every value on its own gas day', () => {
  const gladys = createFakeGladys();
  const states = buildStates(gladys, PCE, [
    { day: '2026-08-01', energy: 44.5, volume: 4, endIndex: 12004, temperature: 18.4 },
  ]);

  assert.equal(states.length, 4);
  for (const state of states) {
    assert.equal(state.created_at.toISOString(), '2026-08-01T12:00:00.000Z');
  }
  assert.deepEqual(
    states.map((state) => [state.device_feature_external_id, state.state]),
    [
      [`${DEVICE_TYPE}:${PCE}:${FEATURE.DAILY_ENERGY}`, 44.5],
      [`${DEVICE_TYPE}:${PCE}:${FEATURE.DAILY_VOLUME}`, 4],
      [`${DEVICE_TYPE}:${PCE}:${FEATURE.INDEX}`, 12004],
      [`${DEVICE_TYPE}:${PCE}:${FEATURE.TEMPERATURE}`, 18.4],
    ],
  );
});

test('buildStates never turns a missing measurement into a zero', () => {
  const gladys = createFakeGladys();
  const states = buildStates(gladys, PCE, [
    {
      day: '2026-08-01',
      energy: 44.5,
      volume: undefined,
      endIndex: undefined,
      temperature: undefined,
    },
  ]);
  assert.deepEqual(
    states.map((state) => state.device_feature_external_id),
    [`${DEVICE_TYPE}:${PCE}:${FEATURE.DAILY_ENERGY}`],
  );
});

test('buildStates keeps a genuine zero (a day without gas is data too)', () => {
  const gladys = createFakeGladys();
  const states = buildStates(gladys, PCE, [{ day: '2026-08-01', energy: 0, volume: 0 }]);
  assert.deepEqual(
    states.map((state) => state.state),
    [0, 0],
  );
});
