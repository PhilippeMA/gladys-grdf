// -----------------------------------------------------------------------------
// Synchronization: GRDF readings -> Gladys states.
//
// One pass, per metering point:
//   1. work out the period to fetch (resume from the cursor, or import the
//      configured history on the first run);
//   2. fetch the daily readings, completing the missing temperatures;
//   3. keep only the gas days newer than the cursor;
//   4. publish them with their own timestamp, in batches;
//   5. move the cursor forward and persist it.
//
// GRDF publishes a reading one to two days late, so there is nothing "live"
// here: the value of a day lands the day after, and the charts fill in as the
// days go by.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addDays, today as todayOf } from './dates.js';
import { buildStates } from './devices/gasMeter.js';
import { normalizeReadings, withTemperatures } from './grdf/readings.js';

const logger = createLogger({ name: 'gazpar' });

/** `publishStates` accepts at most 100 states per request. */
export const MAX_STATES_PER_REQUEST = 100;

/** Hard limit of the import window: GRDF keeps about three years of history. */
export const MAX_HISTORY_DAYS = 1095;

/**
 * First day to ask GRDF for.
 *   - never synchronized yet -> import `historyDays` of history;
 *   - cursor known           -> resume the day after it.
 * In both cases we stay inside the window GRDF actually serves.
 *
 * @param {string|undefined} lastDay cursor, `YYYY-MM-DD`
 * @param {{ historyDays: number, today: string }} options
 */
export function computeStartDay(lastDay, { historyDays, today }) {
  const oldest = addDays(today, -MAX_HISTORY_DAYS);
  const start = lastDay ? addDays(lastDay, 1) : addDays(today, -historyDays);
  return start < oldest ? oldest : start;
}

/**
 * Keep the gas days that have not been published yet.
 * @param {Array<{ day: string }>} readings sorted, oldest first
 * @param {string|undefined} lastDay cursor
 */
export function selectNewReadings(readings, lastDay) {
  return lastDay ? readings.filter((reading) => reading.day > lastDay) : readings;
}

/** Split a list into chunks of at most `size` entries. */
export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Publish states, respecting the batch limit of the host API.
 * @returns {Promise<number>} number of states published
 */
export async function publishStates(gladys, states) {
  for (const batch of chunk(states, MAX_STATES_PER_REQUEST)) {
    await gladys.publishStates(batch);
  }
  return states.length;
}

/**
 * Synchronize ONE metering point.
 *
 * @param {object} gladys SDK instance
 * @param {object} options
 * @param {import('./grdf/client.js').GrdfClient} options.client
 * @param {{ history_days: number }} options.config
 * @param {import('./store.js').SyncStore} options.store
 * @param {{ pce: string }} options.pceEntry
 * @param {import('./throttle.js').Throttle} [options.throttle] rate floor of the
 *   scheduled path; omitted when the user explicitly asked for a refresh
 * @param {Date} [options.now] injectable clock, for the tests
 * @returns {Promise<{ pce: string, days: number, states: number, lastDay?: string }>}
 */
export async function synchronizePce(gladys, { client, config, store, pceEntry, throttle, now }) {
  const pce = String(pceEntry.pce);
  const today = todayOf(now);
  const lastDay = store.get(pce);

  if (throttle && !throttle.allow(pce, now?.getTime())) {
    logger.debug(`PCE ${pce}: skipped, GRDF was queried too recently`);
    return { pce, days: 0, states: 0, lastDay };
  }

  const startDay = computeStartDay(lastDay, { historyDays: config.history_days, today });

  if (startDay > today) {
    logger.debug(`PCE ${pce}: already up to date (cursor ${lastDay})`);
    return { pce, days: 0, states: 0, lastDay };
  }

  logger.info(`PCE ${pce}: fetching readings from ${startDay} to ${today}`);
  const consumption = await client.getConsumption({
    pceList: [pce],
    startDate: startDay,
    endDate: today,
  });

  let readings = normalizeReadings(consumption?.[pce]?.releves);
  readings = selectNewReadings(readings, lastDay);

  if (readings.length === 0) {
    logger.info(`PCE ${pce}: no new reading`);
    return { pce, days: 0, states: 0, lastDay };
  }

  // GRDF often leaves `temperature` null in the readings while the dedicated
  // endpoint still knows it. Best effort: a failure there must not lose the
  // consumption data we already hold.
  if (readings.some((reading) => reading.temperature === undefined)) {
    try {
      const temperatures = await client.getTemperatures({
        pce,
        endDate: today,
        days: Math.max(readings.length, 1),
      });
      readings = withTemperatures(readings, temperatures);
    } catch (err) {
      logger.warn(`PCE ${pce}: could not fetch the temperatures (${err.message})`);
    }
  }

  const states = buildStates(gladys, pce, readings);
  await publishStates(gladys, states);

  const newLastDay = readings[readings.length - 1].day;
  store.set(pce, newLastDay);
  await store.save();

  logger.info(`PCE ${pce}: ${readings.length} day(s) published, up to ${newLastDay}`);
  return { pce, days: readings.length, states: states.length, lastDay: newLastDay };
}

/**
 * Synchronize every metering point, one after the other. A meter that fails
 * does not prevent the others from being synchronized: the error is collected
 * and reported to the caller.
 *
 * @returns {Promise<{ days: number, states: number, errors: Array<{ pce: string, message: string }> }>}
 */
export async function synchronizeAll(gladys, { client, config, store, pceEntries, throttle, now }) {
  const summary = { days: 0, states: 0, errors: [] };

  for (const pceEntry of pceEntries) {
    try {
      const result = await synchronizePce(gladys, {
        client,
        config,
        store,
        pceEntry,
        throttle,
        now,
      });
      summary.days += result.days;
      summary.states += result.states;
    } catch (err) {
      logger.error(`PCE ${pceEntry.pce}: synchronization failed`, err);
      summary.errors.push({ pce: String(pceEntry.pce), message: err.message });
    }
  }

  return summary;
}
