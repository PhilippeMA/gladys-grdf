import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STATES_PER_REQUEST,
  MAX_STATES_PER_WINDOW,
  StatePublisher,
  WINDOW_MS,
} from '../src/publisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

/** A publisher with a controlled clock and a sleep that only records. */
function createTestPublisher(options = {}) {
  const sleeps = [];
  let clock = 0;
  const publisher = new StatePublisher({
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms; // sleeping moves the clock, like the real one does
    },
    now: () => clock,
    ...options,
  });
  return { publisher, sleeps, advance: (ms) => (clock += ms) };
}

function states(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    device_feature_external_id: 'ext:grdf:feature',
    state: index,
  }));
}

test('states are published in requests of at most 100', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createTestPublisher();

  const count = await publisher.publish(gladys, states(250));

  assert.equal(count, 250);
  assert.deepEqual(
    gladys.batches.map((batch) => batch.length),
    [100, 100, 50],
  );
});

test('a small batch never waits', async () => {
  const gladys = createFakeGladys();
  const { publisher, sleeps } = createTestPublisher();

  await publisher.publish(gladys, states(100));

  assert.deepEqual(sleeps, []);
});

test('publishing beyond the per-minute budget waits for the window to roll over', async () => {
  const gladys = createFakeGladys();
  const { publisher, sleeps } = createTestPublisher();

  // The budget is 250: the first window is filled exactly (100 + 100 + 50),
  // then the last 50 states wait for the next one.
  await publisher.publish(gladys, states(300));

  assert.deepEqual(sleeps, [WINDOW_MS]);
  assert.deepEqual(
    gladys.batches.map((batch) => batch.length),
    [100, 100, 50, 50],
  );
});

test('a three-year import is paced instead of being rejected', async () => {
  const gladys = createFakeGladys();
  const { publisher, sleeps } = createTestPublisher();

  // 1095 days x 4 features: what the largest configurable history produces.
  const total = 1095 * 4;
  await publisher.publish(gladys, states(total));

  assert.equal(
    gladys.batches.reduce((sum, batch) => sum + batch.length, 0),
    total,
  );
  // Every request stayed within the limit, and the budget was used in full:
  // one wait per window, and no window wasted.
  assert.ok(gladys.batches.every((batch) => batch.length <= MAX_STATES_PER_REQUEST));
  assert.equal(sleeps.length, Math.ceil(total / MAX_STATES_PER_WINDOW) - 1);
  assert.ok(sleeps.every((ms) => ms === WINDOW_MS));
});

test('the budget refills on its own once the window has passed', async () => {
  const gladys = createFakeGladys();
  const { publisher, sleeps, advance } = createTestPublisher();

  await publisher.publish(gladys, states(200));
  advance(WINDOW_MS + 1); // a quiet minute goes by
  await publisher.publish(gladys, states(200));

  assert.deepEqual(sleeps, []);
});

test('the budget is shared across calls inside the same window', async () => {
  const gladys = createFakeGladys();
  const { publisher, sleeps } = createTestPublisher();

  await publisher.publish(gladys, states(200));
  await publisher.publish(gladys, states(100));

  assert.deepEqual(sleeps, [WINDOW_MS]);
});

test('the budget stays under what the host API enforces', () => {
  assert.ok(MAX_STATES_PER_WINDOW < 300, 'the core rejects above 300 states per minute');
  assert.equal(MAX_STATES_PER_REQUEST, 100);
});

test('publishing nothing does nothing', async () => {
  const gladys = createFakeGladys();
  const { publisher, sleeps } = createTestPublisher();

  assert.equal(await publisher.publish(gladys, []), 0);
  assert.deepEqual(gladys.batches, []);
  assert.deepEqual(sleeps, []);
});
