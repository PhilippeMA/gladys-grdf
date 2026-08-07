import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STATES_PER_REQUEST,
  MAX_STATES_PER_WINDOW,
  StatePublisher,
  WINDOW_MARGIN_MS,
  WINDOW_MS,
  isRateLimited,
} from '../src/publisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

/** A publisher with a controlled clock and a sleep that only records. */
function createTestPublisher(options = {}) {
  const sleeps = [];
  const clock = { t: 0 };
  const publisher = new StatePublisher({
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms; // sleeping moves the clock, like the real one does
    },
    now: () => clock.t,
    ...options,
  });
  return { publisher, sleeps, clock, advance: (ms) => (clock.t += ms) };
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

  assert.deepEqual(sleeps, [WINDOW_MS + WINDOW_MARGIN_MS]);
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
  assert.ok(sleeps.every((ms) => ms === WINDOW_MS + WINDOW_MARGIN_MS));
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

  assert.deepEqual(sleeps, [WINDOW_MS + WINDOW_MARGIN_MS]);
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

/** The error the host API raises past 300 states in a minute. */
function rateLimitError() {
  const err = new Error('Too Many Requests');
  err.status = 429;
  err.code = 'TOO_MANY_REQUESTS';
  return err;
}

test('isRateLimited recognizes the host API refusal, whatever its shape', () => {
  assert.equal(isRateLimited(rateLimitError()), true);
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited({ code: 'TOO_MANY_REQUESTS' }), true);
  assert.equal(isRateLimited({ message: 'Too Many Requests' }), true);
  assert.equal(isRateLimited(new Error('boom')), false);
  assert.equal(isRateLimited(undefined), false);
});

test('the window is anchored on the acknowledgement, not on the decision to send', async () => {
  // The bug this guards: the core starts counting when the request ARRIVES,
  // we used to start when we decided to send. Waiting exactly one window from
  // our own anchor then resumed a round trip too early — and earned a 429 on
  // a perfectly paced import.
  const LATENCY = 1000;
  const { publisher, clock } = createTestPublisher();
  const sentAt = [];
  const gladys = {
    async publishStates(_batch) {
      sentAt.push(clock.t);
      clock.t += LATENCY; // the request takes time; the core counted at its start
    },
  };

  await publisher.publish(gladys, states(300));

  // Three requests fill the window (100 + 100 + 50). The core started counting
  // when the first one arrived, at t=0, and resets at t=WINDOW_MS; we only
  // learn of it at t=LATENCY. The fourth request must land after the core's
  // reset, not after ours.
  const coreWindowClosesAt = sentAt[0] + WINDOW_MS;
  assert.equal(sentAt.length, 4);
  assert.ok(
    sentAt[3] > coreWindowClosesAt,
    `resumed at ${sentAt[3]}, before the core's window closed at ${coreWindowClosesAt}`,
  );
});

test('a batch refused for rate limit is waited out and sent again', async () => {
  const { publisher, sleeps } = createTestPublisher();
  const attempts = [];
  const gladys = {
    async publishStates(batch) {
      attempts.push(batch.length);
      if (attempts.length === 1) {
        throw rateLimitError();
      }
    },
  };

  await publisher.publish(gladys, states(50));

  // The very same batch, sent again after a full window.
  assert.deepEqual(attempts, [50, 50]);
  assert.deepEqual(sleeps, [WINDOW_MS + WINDOW_MARGIN_MS]);
});

test('a rate limit that never clears is surfaced instead of looping forever', async () => {
  const { publisher, sleeps } = createTestPublisher({ maxRateLimitRetries: 3 });
  const gladys = {
    async publishStates() {
      throw rateLimitError();
    },
  };

  await assert.rejects(publisher.publish(gladys, states(10)), /Too Many Requests/);
  assert.equal(sleeps.length, 2); // two waits, three attempts
});

test('an error that is not a rate limit is not retried', async () => {
  const { publisher, sleeps } = createTestPublisher();
  let calls = 0;
  const gladys = {
    async publishStates() {
      calls += 1;
      throw new Error('database is on fire');
    },
  };

  await assert.rejects(publisher.publish(gladys, states(10)), /database is on fire/);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});
