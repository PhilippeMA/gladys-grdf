// -----------------------------------------------------------------------------
// Minimum delay between two GRDF requests for the same metering point.
//
// The poll interval is chosen by the user and scheduled by Gladys; this is the
// integration's own floor, and it exists because GRDF is somebody else's
// website, not an API we are entitled to hammer. A new reading appears once a
// day: asking more than twice an hour can only be a mistake — a misconfigured
// interval, a restart loop, several meters polled together.
//
// It only guards the scheduled path. The explicit "Refresh the data now" button
// and the initial synchronization go through, because the user asked.
// -----------------------------------------------------------------------------

/** Half an hour: far below the daily publication rhythm, far above a storm. */
export const MIN_POLL_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Floor for a meter that has never imported anything yet. Its first import is
 * the one the user is waiting on, right after adding the meter, and if it
 * fails they are left with an empty dashboard — so retry sooner than the
 * nominal floor, while still keeping GRDF out of a retry storm.
 */
export const FIRST_IMPORT_INTERVAL_MS = 5 * 60 * 1000;

export class Throttle {
  /**
   * @param {number} minIntervalMs minimum delay between two allowed runs
   */
  constructor(minIntervalMs = MIN_POLL_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs;
    /** @type {Map<string, number>} last allowed run, keyed by anything */
    this.lastRunAt = new Map();
  }

  /**
   * May `key` run now? Records the run when it may, so two calls in a row give
   * `true` then `false`.
   * @param {string} key
   * @param {number} [now] epoch milliseconds, injectable for the tests
   * @param {number} [minIntervalMs] a floor for THIS call, overriding the
   *   default — a meter that has never imported anything is worth retrying
   *   sooner than one that is merely due for its next reading
   */
  allow(key, now = Date.now(), minIntervalMs = this.minIntervalMs) {
    const last = this.lastRunAt.get(key);
    if (last !== undefined && now - last < minIntervalMs) {
      return false;
    }
    this.lastRunAt.set(key, now);
    return true;
  }

  /** Forget a key, so the next call is allowed again. */
  reset(key) {
    this.lastRunAt.delete(key);
  }
}
