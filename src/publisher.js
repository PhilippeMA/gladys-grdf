// -----------------------------------------------------------------------------
// Paced publishing of the device states.
//
// The host API enforces two limits on an integration (contract C.3):
//   - 100 states per request;
//   - 300 states per minute, per integration — over that it answers 429 and the
//     whole batch is LOST (the SDK does not retry).
//
// An import of past days blows straight through the second one: four features
// per day means 300 states in 75 days, and the history window can reach three
// years. So we pace ourselves — publish a window's worth, wait for the window
// to roll over, carry on.
//
// The budget is per integration, not per meter: one instance is shared by every
// synchronization so two meters importing together cannot bust it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'publisher' });

/** Hard limit of the host API. */
export const MAX_STATES_PER_REQUEST = 100;

/**
 * States per minute we allow ourselves. Below the 300 the core enforces: its
 * window is a fixed one starting when IT first counted, ours starts when we
 * first published, and the two are never aligned. The margin absorbs the
 * overlap instead of gambling on it.
 */
export const MAX_STATES_PER_WINDOW = 250;

export const WINDOW_MS = 60_000;

/**
 * Slack added to every wait. Our window and the core's are anchored on two
 * different events — we time from the acknowledgement, it times from the
 * arrival — and the gap between them is a network round trip. Waiting exactly
 * one window lands a hair BEFORE the core's reset, which costs a whole batch;
 * waiting a little longer costs a second.
 */
export const WINDOW_MARGIN_MS = 5_000;

/** How many times one batch may be re-sent after a rate-limit refusal. */
export const MAX_RATE_LIMIT_RETRIES = 4;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is this error the host API saying "too many states, slow down"? */
export function isRateLimited(err) {
  return (
    err?.status === 429 ||
    err?.statusCode === 429 ||
    err?.code === 'TOO_MANY_REQUESTS' ||
    /too many requests|rate_limit/i.test(err?.message ?? '')
  );
}

export class StatePublisher {
  /**
   * @param {object} [options]
   * @param {number} [options.maxPerRequest]
   * @param {number} [options.maxPerWindow]
   * @param {number} [options.windowMs]
   * @param {number} [options.marginMs]
   * @param {number} [options.maxRateLimitRetries]
   * @param {(ms: number) => Promise<void>} [options.sleep] injectable, for the tests
   * @param {() => number} [options.now] injectable clock, for the tests
   */
  constructor({
    maxPerRequest = MAX_STATES_PER_REQUEST,
    maxPerWindow = MAX_STATES_PER_WINDOW,
    windowMs = WINDOW_MS,
    marginMs = WINDOW_MARGIN_MS,
    maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = {}) {
    this.maxPerRequest = maxPerRequest;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.marginMs = marginMs;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.sleep = sleep;
    this.now = now;
    this.windowStartedAt = undefined;
    this.countInWindow = 0;
  }

  /**
   * Publish every state, in batches, never exceeding the budget.
   * @param {object} gladys SDK instance
   * @param {Array<object>} states
   * @returns {Promise<number>} number of states published
   */
  async publish(gladys, states) {
    let index = 0;
    while (index < states.length) {
      // Batches are sized by what is LEFT in the window, not by the request
      // limit alone: with 250 per window and 100 per request, fixed chunks
      // would leave 50 unused every minute and stretch a long import by a
      // fifth for nothing.
      const available = await this.#waitForRoom();
      const size = Math.min(this.maxPerRequest, available, states.length - index);
      const batch = states.slice(index, index + size);

      await this.#publishBatch(gladys, batch);

      // The window is anchored on the moment the server ACKNOWLEDGED the first
      // batch, never on the moment we decided to send it. The core starts its
      // own window when the request arrives, so anchoring before the round
      // trip leaves us ahead of it by the request latency — and a wait of
      // exactly one window then lands just before the core's reset, which is
      // precisely how a paced import still earns a 429.
      if (this.countInWindow === 0) {
        this.windowStartedAt = this.now();
      }
      this.countInWindow += size;
      index += size;
    }
    return states.length;
  }

  /** Publish one batch, riding out a rate limit rather than losing the import. */
  async #publishBatch(gladys, batch) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await gladys.publishStates(batch);
        return;
      } catch (err) {
        if (!isRateLimited(err) || attempt >= this.maxRateLimitRetries) {
          throw err;
        }
        // Our accounting and the core's disagree: forget ours, wait out a full
        // window and send the very same batch again.
        logger.warn(
          `Gladys refused the batch (rate limit): waiting ${Math.ceil((this.windowMs + this.marginMs) / 1000)}s and publishing it again`,
        );
        await this.sleep(this.windowMs + this.marginMs);
        this.windowStartedAt = undefined;
        this.countInWindow = 0;
      }
    }
  }

  /**
   * Room left in the current window, waiting for the next one when it is full.
   * @returns {Promise<number>} always at least 1
   */
  async #waitForRoom() {
    const now = this.now();
    if (this.windowStartedAt === undefined || now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = undefined; // re-anchored on the next acknowledgement
      this.countInWindow = 0;
      return this.maxPerWindow;
    }
    const remaining = this.maxPerWindow - this.countInWindow;
    if (remaining > 0) {
      return remaining;
    }
    // The margin covers the drift between the two clocks and the two windows:
    // being a second early costs a rejected batch, being a second late costs
    // a second.
    const waitMs = this.windowStartedAt + this.windowMs + this.marginMs - now;
    if (waitMs > 0) {
      logger.info(`Rate limit: waiting ${Math.ceil(waitMs / 1000)}s before publishing more states`);
      await this.sleep(waitMs);
    }
    this.windowStartedAt = undefined;
    this.countInWindow = 0;
    return this.maxPerWindow;
  }
}
