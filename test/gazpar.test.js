import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DAYS_PER_COMMIT,
  MAX_HISTORY_DAYS,
  chunk,
  computeStartDay,
  selectNewReadings,
  synchronizeAll,
  synchronizePce,
} from '../src/gazpar.js';
import { addDays } from '../src/dates.js';
import { deviceExternalId } from '../src/devices/gasMeter.js';
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

/**
 * A fake Gladys where the given meters HAVE been added to the home by the user.
 * `hasValues: false` reproduces a device that was created but never received
 * anything — the situation a lying cursor leaves behind.
 */
function createGladysWithDevices(pces = [PCE], { hasValues = true } = {}) {
  const ids = createFakeGladys();
  const devices = pces.map((pce) => ({
    external_id: deviceExternalId(ids, pce),
    features: [
      {
        external_id: `${deviceExternalId(ids, pce)}:daily-energy`,
        last_value: hasValues ? 42 : null,
      },
    ],
  }));
  return createFakeGladys({ devices });
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

test('a first synchronization imports the history and moves the cursor', async () => {
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices();
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05')] });
  const throttled = { client, config: CONFIG, store, pceEntry: { pce: PCE }, now: NOW };

  await synchronizePce(gladys, { ...throttled, throttle: new Throttle() });
  await synchronizePce(gladys, throttled);

  assert.equal(client.calls.consumption.length, 2);
});

test('the missing temperatures are completed from the meteo endpoint', async () => {
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices();
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
  const gladys = createGladysWithDevices([PCE, '98765432109876']);
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

test('nothing is collected for a meter the user has not added to Gladys yet', async () => {
  // The core drops states aimed at a device that does not exist, silently.
  // Fetching GRDF for nobody would burn the cursor on data nobody receives.
  const gladys = createFakeGladys({ devices: [] });
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05')] });

  const result = await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(result.days, 0);
  assert.equal(result.skipped, 'not-created');
  assert.deepEqual(client.calls.consumption, [], 'GRDF must not be queried for nobody');
  assert.equal(store.get(PCE), undefined, 'the cursor must not move');
});

test('a cursor is rewound when Gladys turns out to hold nothing for the meter', async () => {
  // Exactly what a first run before the device existed leaves behind: the
  // cursor says the week was published, the device has never held a value.
  const gladys = createGladysWithDevices([PCE], { hasValues: false });
  const store = await createStore();
  store.set(PCE, '2026-08-05');
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

  // The whole history window was asked for again, not just the days after the
  // stale cursor.
  assert.equal(client.calls.consumption[0].startDate, '2026-07-31');
  assert.equal(result.days, 3);
  assert.equal(store.get(PCE), '2026-08-06');
});

test('a cursor is kept when the meter already holds values', async () => {
  const gladys = createGladysWithDevices([PCE], { hasValues: true });
  const store = await createStore();
  store.set(PCE, '2026-08-05');
  const client = createFakeClient({ releves: [releve('2026-08-06')] });

  await synchronizePce(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });

  assert.equal(client.calls.consumption[0].startDate, '2026-08-06');
});

test('synchronizeAll counts the meters still waiting to be added', async () => {
  const gladys = createFakeGladys({ devices: [] });
  const store = await createStore();
  const client = createFakeClient({ releves: [releve('2026-08-05')] });

  const summary = await synchronizeAll(gladys, {
    client,
    config: CONFIG,
    store,
    pceEntries: [{ pce: PCE }, { pce: '98765432109876' }],
    now: NOW,
  });

  assert.equal(summary.waiting, 2);
  assert.equal(summary.days, 0);
  assert.deepEqual(summary.errors, []);
});

test('chunk splits a list without losing anything', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test('a long import commits its cursor as it goes, and resumes where it stopped', async () => {
  // Importing months of history takes minutes because publishing is paced. If
  // the cursor only moved at the very end, any failure would restart from the
  // first day — forever, for a history long enough to fail.
  const gladys = createGladysWithDevices();
  const store = await createStore();
  const days = Array.from({ length: DAYS_PER_COMMIT * 3 }, (_unused, index) =>
    releve(addDays('2026-05-01', index)),
  );
  const client = createFakeClient({ releves: days });

  // A publisher that dies in the middle of the second slice.
  let slices = 0;
  const failingPublisher = {
    async publish(_gladys, states) {
      slices += 1;
      if (slices === 2) {
        const err = new Error('Too Many Requests');
        err.status = 429;
        throw err;
      }
      return states.length;
    },
  };

  await assert.rejects(
    synchronizePce(gladys, {
      client,
      config: { ...CONFIG, history_days: 120 },
      store,
      pceEntry: { pce: PCE },
      publisher: failingPublisher,
      now: NOW,
    }),
    /Too Many Requests/,
  );

  // The first slice was committed, and only it.
  const committed = store.get(PCE);
  assert.equal(committed, addDays('2026-05-01', DAYS_PER_COMMIT - 1));

  // A second attempt picks up the day after, instead of starting over.
  const resumed = createFakeClient({ releves: days });
  await synchronizePce(gladys, {
    client: resumed,
    config: { ...CONFIG, history_days: 120 },
    store,
    pceEntry: { pce: PCE },
    now: NOW,
  });
  assert.equal(resumed.calls.consumption[0].startDate, addDays(committed, 1));
  assert.equal(store.get(PCE), addDays('2026-05-01', DAYS_PER_COMMIT * 3 - 1));
});
