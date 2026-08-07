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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class StatePublisher {
  /**
   * @param {object} [options]
   * @param {number} [options.maxPerRequest]
   * @param {number} [options.maxPerWindow]
   * @param {number} [options.windowMs]
   * @param {(ms: number) => Promise<void>} [options.sleep] injectable, for the tests
   * @param {() => number} [options.now] injectable clock, for the tests
   */
  constructor({
    maxPerRequest = MAX_STATES_PER_REQUEST,
    maxPerWindow = MAX_STATES_PER_WINDOW,
    windowMs = WINDOW_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = {}) {
    this.maxPerRequest = maxPerRequest;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
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
      this.countInWindow += size;
      await gladys.publishStates(batch);
      index += size;
    }
    return states.length;
  }

  /**
   * Room left in the current window, waiting for the next one when it is full.
   * @returns {Promise<number>} always at least 1
   */
  async #waitForRoom() {
    const now = this.now();
    if (this.windowStartedAt === undefined || now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.countInWindow = 0;
    }
    const remaining = this.maxPerWindow - this.countInWindow;
    if (remaining > 0) {
      return remaining;
    }
    const waitMs = this.windowStartedAt + this.windowMs - now;
    if (waitMs > 0) {
      logger.info(`Rate limit: waiting ${Math.ceil(waitMs / 1000)}s before publishing more states`);
      await this.sleep(waitMs);
    }
    this.windowStartedAt = this.now();
    this.countInWindow = 0;
    return this.maxPerWindow;
  }
}
