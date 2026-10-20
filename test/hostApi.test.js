// -----------------------------------------------------------------------------
// Contract tests against the SDK's fake Gladys.
//
// `@gladysassistant/integration-sdk/testing` gives a real GladysIntegration
// over an in-memory Gladys that validates payloads the way the host API does —
// external id prefixes, known categories, types and units, poll frequencies,
// and the rules of the dated-consumption endpoint.
//
// That is the gap the unit tests cannot cover: every production bug of this
// integration so far has been a payload Gladys refused, not logic that
// miscomputed. These tests publish what the integration really publishes and
// let Gladys judge it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { FEATURE, externalIdsFor } from '../src/devices/gasMeter.js';
import { synchronizePce } from '../src/gazpar.js';
import { SyncStore } from '../src/store.js';

const PCE = '01234567890123';
const NOW = new Date('2026-08-07T09:00:00.000Z');
const CONFIG = { history_days: 7, poll_frequency: 21600 };

function releve(day, overrides = {}) {
  return {
    journeeGaziere: day,
    dateFinReleve: `${day}T06:00:00+02:00`,
    indexDebut: 12000,
    indexFin: 12004,
    volumeBrutConsomme: 4,
    energieConsomme: 44.5,
    coeffConversion: 11.12,
    temperature: 18.4,
    qualificationReleve: 'Mesuré',
    status: 'Définitive',
    ...overrides,
  };
}

function createFakeClient(releves) {
  return {
    async getConsumption({ pceList }) {
      return { [pceList[0]]: { releves } };
    },
    async getTemperatures() {
      return {};
    },
  };
}

async function createStore() {
  return new SyncStore({ directory: await mkdtemp(path.join(tmpdir(), 'gazpar-contract-')) });
}

/** The device as the user would have created it from the Discovery screen. */
function createdDeviceFrom(discovered) {
  return {
    ...discovered,
    features: discovered.features.map((feature) => ({ ...feature, last_value: null })),
  };
}

test('Gladys accepts the discovered device exactly as the integration publishes it', async () => {
  const gladys = createFakeGladys();

  const devices = buildDiscoveredDevices(gladys, [{ pce: PCE, alias: 'Maison' }]);
  await gladys.publishDiscoveredDevices(devices);

  // Accepted: had a category, a type, a unit or a poll frequency been wrong,
  // the fake would have answered 400 like the host API.
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.requests.at(-1).status, 200);
});

test('the meter index is not published as an energy index', async () => {
  // An `energy-sensor`/`index` feature makes Gladys derive a half-hourly
  // consumption and a cost from its deltas, under the main ELECTRIC meter.
  // Ours counts cubic metres of gas: that pipeline would bill m³ at the
  // electricity price.
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [{ pce: PCE }]);

  const index = device.features.find((feature) =>
    feature.external_id.endsWith(`:${FEATURE.INDEX}`),
  );
  assert.equal(index.category, 'volume-sensor');
  assert.ok(
    !device.features.some(
      (feature) => feature.category === 'energy-sensor' && feature.type === 'index',
    ),
    'no feature may claim to be a cumulative energy index',
  );
});

test('Gladys accepts the daily consumption through the dated-consumption API', async () => {
  const bare = createFakeGladys();
  const [discovered] = buildDiscoveredDevices(bare, [{ pce: PCE }]);
  const gladys = createFakeGladys({ devices: [createdDeviceFrom(discovered)] });
  const store = await createStore();

  const result = await synchronizePce(gladys, {
    client: createFakeClient([releve('2026-08-05'), releve('2026-08-06')]),
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(result.days, 2);

  // The consumption landed on the consumption endpoint, dated by gas day...
  const energyFeatureId = externalIdsFor(gladys, PCE).feature(FEATURE.DAILY_ENERGY);
  const stored = gladys.fake.energyConsumption[energyFeatureId];
  assert.equal(stored.length, 2, 'both days are stored as intervals');
  assert.deepEqual(
    gladys.fake.publishedEnergyConsumption.flatMap((published) =>
      published.intervals.map((interval) => interval.date),
    ),
    ['2026-08-05', '2026-08-06'],
  );

  // ...and never as a state, whose instant is not an interval.
  assert.ok(
    !gladys.fake.states.some((state) => state.device_feature_external_id === energyFeatureId),
    'the consumption must not go through the states path',
  );
});

test('the other measurements still go through the states path', async () => {
  const bare = createFakeGladys();
  const [discovered] = buildDiscoveredDevices(bare, [{ pce: PCE }]);
  const gladys = createFakeGladys({ devices: [createdDeviceFrom(discovered)] });
  const store = await createStore();

  await synchronizePce(gladys, {
    client: createFakeClient([releve('2026-08-05')]),
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  const ids = externalIdsFor(gladys, PCE);
  const published = gladys.fake.states.map((state) => state.device_feature_external_id);
  assert.ok(published.includes(ids.feature(FEATURE.DAILY_VOLUME)));
  assert.ok(published.includes(ids.feature(FEATURE.INDEX)));
  assert.ok(published.includes(ids.feature(FEATURE.TEMPERATURE)));
  // Every state was accepted by the host API validation.
  assert.ok(
    gladys.fake.requests
      .filter((request) => request.path === '/state')
      .every((r) => r.status === 200),
  );
});

test('Gladys refuses the consumption of a device the user has not created', async () => {
  // The integration guards against this itself (it asks getDevices first), but
  // the guarantee is worth pinning: a 404 here is what the SDK promises.
  const gladys = createFakeGladys({ devices: [] });
  const energyFeatureId = externalIdsFor(gladys, PCE).feature(FEATURE.DAILY_ENERGY);

  await assert.rejects(
    gladys.publishEnergyConsumption(energyFeatureId, [{ date: '2026-08-05', kwh: 44.5 }]),
    (err) => {
      assert.match(String(err.status ?? err.message), /404|not found/i);
      return true;
    },
  );
});
