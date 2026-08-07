import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_HISTORY_DAYS,
  chunk,
  computeStartDay,
  publishStates,
  selectNewReadings,
  synchronizeAll,
  synchronizePce,
} from '../src/gazpar.js';
import { SyncStore } from '../src/store.js';
import { Throttle } from '../src/throttle.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const PCE = '01234567890123';
const NOW = new Date('2026-08-07T09:00:00.000Z');
const CONFIG = { history_days: 7, poll_frequency: 21600 };

/** A GRDF client stub recording what it was asked for. */
function createFakeClient({ releves = [], temperatures = {}, failWith } = {}) {
  const calls = { consumption: [], temperatures: [] };
  return {
    calls,
    async getConsumption(options) {
      calls.consumption.push(options);
      if (failWith) {
        throw failWith;
      }
      const pce = options.pceList[0];
      return { [pce]: { idPce: pce, releves } };
    },
    async getTemperatures(options) {
      calls.temperatures.push(options);
      return temperatures;
    },
  };
}

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'gazpar-test-'));
  return new SyncStore({ directory });
}

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

test('computeStartDay imports the configured history on the first run', () => {
  assert.equal(computeStartDay(undefined, { historyDays: 7, today: '2026-08-07' }), '2026-07-31');
});

test('computeStartDay resumes the day after the cursor', () => {
  assert.equal(
    computeStartDay('2026-08-05', { historyDays: 7, today: '2026-08-07' }),
    '2026-08-06',
  );
});

test('computeStartDay never asks for more history than GRDF keeps', () => {
  const start = computeStartDay(undefined, { historyDays: 100000, today: '2026-08-07' });
  const oldestAllowed = new Date(
    Date.parse('2026-08-07T00:00:00Z') - MAX_HISTORY_DAYS * 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  assert.equal(start, oldestAllowed);
});

test('selectNewReadings keeps everything when nothing was ever published', () => {
  const readings = [{ day: '2026-08-01' }, { day: '2026-08-02' }];
  assert.deepEqual(selectNewReadings(readings, undefined), readings);
});

test('selectNewReadings drops the days already published', () => {
  const readings = [{ day: '2026-08-01' }, { day: '2026-08-02' }, { day: '2026-08-03' }];
  assert.deepEqual(selectNewReadings(readings, '2026-08-02'), [{ day: '2026-08-03' }]);
});

test('chunk splits a list without losing anything', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test('publishStates respects the 100-states-per-request limit', async () => {
  const gladys = createFakeGladys();
  const states = Array.from({ length: 250 }, (_unused, index) => ({
    device_feature_external_id: 'feature',
    state: index,
  }));

  const count = await publishStates(gladys, states);

  assert.equal(count, 250);
  assert.deepEqual(
    gladys.batches.map((batch) => batch.length),
    [100, 100, 50],
  );
});

test('a first synchronization imports the history and moves the cursor', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const client = createFakeClient({
    releves: [releve('2026-08-04'), releve('2026-08-05'), releve('2026-08-06')],
  });

  const result = await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(result.days, 3);
  assert.equal(result.states, 12); // 4 features x 3 days
  assert.equal(store.get(PCE), '2026-08-06');
  assert.deepEqual(client.calls.consumption[0], {
    pceList: [PCE],
    startDate: '2026-07-31',
    endDate: '2026-08-07',
  });
});

test('the cursor survives a restart: the second pass publishes nothing new', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const releves = [releve('2026-08-05'), releve('2026-08-06')];

  await synchronizePce(gladys, {
    client: createFakeClient({ releves }),
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });
  const publishedFirstPass = gladys.published.length;

  // A brand new store, reading the file the first pass wrote.
  const reloaded = await new SyncStore({ directory: path.dirname(store.filePath) }).load();
  const client = createFakeClient({ releves });
  const result = await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store: reloaded,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(result.days, 0);
  assert.equal(gladys.published.length, publishedFirstPass);
  // It only asked GRDF for the days after the cursor.
  assert.equal(client.calls.consumption[0].startDate, '2026-08-07');
});

test('nothing is fetched when the cursor is already past today', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  store.set(PCE, '2026-08-07');
  const client = createFakeClient({ releves: [releve('2026-08-07')] });

  const result = await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(result.days, 0);
  assert.deepEqual(client.calls.consumption, []);
});

test('the scheduled path never queries GRDF twice in a row for the same meter', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05')] });
  const throttle = new Throttle();
  const options = { client, config: CONFIG, store, pceEntry: { pce: PCE }, throttle, now: NOW };

  await synchronizePce(gladys, options);
  const second = await synchronizePce(gladys, options);

  assert.equal(second.days, 0);
  assert.equal(client.calls.consumption.length, 1);
});

test('an explicit refresh (no throttle) always goes through', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05')] });
  const throttled = { client, config: CONFIG, store, pceEntry: { pce: PCE }, now: NOW };

  await synchronizePce(gladys, { ...throttled, throttle: new Throttle() });
  await synchronizePce(gladys, throttled);

  assert.equal(client.calls.consumption.length, 2);
});

test('the missing temperatures are completed from the meteo endpoint', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const client = createFakeClient({
    releves: [releve('2026-08-05', { temperature: null })],
    temperatures: { '2026-08-05': 21.5 },
  });

  await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  const temperature = gladys.published.find((state) =>
    state.featureExternalId.endsWith(':temperature'),
  );
  assert.equal(temperature.state, 21.5);
  assert.equal(client.calls.temperatures.length, 1);
});

test('the meteo endpoint is not called when every reading has its temperature', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05')] });

  await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.deepEqual(client.calls.temperatures, []);
});

test('a failing temperature lookup does not lose the consumption', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05', { temperature: null })] });
  client.getTemperatures = async () => {
    throw new Error('meteo is down');
  };

  const result = await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(result.days, 1);
  assert.equal(result.states, 3); // energy, volume and index, but no temperature
  assert.equal(store.get(PCE), '2026-08-05');
});

test('synchronizeAll keeps going when one meter fails, and reports it', async () => {
  const gladys = createFakeGladys();
  const store = await createStore();
  const failing = createFakeClient({ failWith: new Error('GRDF answered HTTP 500') });
  const working = createFakeClient({ releves: [releve('2026-08-05')] });

  const client = {
    async getConsumption(options) {
      return options.pceList[0] === PCE
        ? failing.getConsumption(options)
        : working.getConsumption(options);
    },
    getTemperatures: working.getTemperatures,
  };

  const summary = await synchronizeAll(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntries: [{ pce: PCE }, { pce: '98765432109876' }],
    now: NOW,
  });

  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].pce, PCE);
  assert.match(summary.errors[0].message, /HTTP 500/);
  // The second meter was still synchronized, and only it moved its cursor.
  assert.equal(summary.days, 1);
  assert.equal(store.get('98765432109876'), '2026-08-05');
  assert.equal(store.get(PCE), undefined);
});
