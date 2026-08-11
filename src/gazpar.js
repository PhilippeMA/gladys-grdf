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
import { findCreatedDevice, hasAnyValue } from './created.js';
import { addDays, today as todayOf } from './dates.js';
import { buildStates, deviceExternalId } from './devices/gasMeter.js';
import { normalizeReadings, withTemperatures } from './grdf/readings.js';
import { StatePublisher } from './publisher.js';
import { FIRST_IMPORT_INTERVAL_MS } from './throttle.js';

const logger = createLogger({ name: 'gazpar' });

/**
 * Days imported before the cursor is written again. Four features per day, so
 * this is one full request worth of states: frequent enough that a failure
 * loses almost nothing, rare enough not to rewrite the cursor file constantly.
 */
export const DAYS_PER_COMMIT = 25;

/** Split a list into chunks of at most `size` entries. */
export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

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
 * @param {import('./publisher.js').StatePublisher} [options.publisher] shared
 *   states budget; a private one is used when it is omitted
 * @param {Date} [options.now] injectable clock, for the tests
 * @returns {Promise<{ pce: string, days: number, states: number, lastDay?: string }>}
 */
export async function synchronizePce(
  gladys,
  { client, config, store, pceEntry, throttle, publisher, createdDevices, now },
) {
  const pce = String(pceEntry.pce);
  const today = todayOf(now);
  const externalId = deviceExternalId(gladys, pce);

  // Nothing to publish to until the user adds the meter from the Discovery
  // screen: the core drops states aimed at a device that does not exist, and
  // it does not tell us. Fetching GRDF for nobody would only burn the cursor.
  const devices = createdDevices ?? (await gladys.getDevices());
  const device = findCreatedDevice(devices, externalId);
  if (!device) {
    logger.info(
      `PCE ${pce}: not added to Gladys yet, skipping (add it from the Discovery tab to start collecting)`,
    );
    return { pce, days: 0, states: 0, lastDay: store.get(pce), skipped: 'not-created' };
  }

  let lastDay = store.get(pce);

  // A cursor claiming days were published for a device that has never held a
  // single value can only be wrong: those states were sent before the user
  // created the device and went nowhere. Rewind and import them again.
  if (lastDay && !hasAnyValue(device)) {
    logger.warn(
      `PCE ${pce}: Gladys holds no value for this meter although the cursor says ${lastDay}; ` +
        'the readings were published before the device existed. Importing the history again.',
    );
    store.reset(pce);
    await store.save();
    lastDay = undefined;
  }

  // A meter that has never imported anything is the one the user is waiting
  // on, right after adding it. If that first import fails — a GRDF hiccup, a
  // rate limit — the nominal half-hour floor would leave them looking at an
  // empty dashboard for far too long, so it retries sooner.
  const firstImport = !lastDay;
  if (
    throttle &&
    !throttle.allow(pce, now?.getTime(), firstImport ? FIRST_IMPORT_INTERVAL_MS : undefined)
  ) {
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
      // A 404 means GRDF simply has no weather series for this meter — normal
      // for many PCE, and not worth a warning on every single pass.
      const level = err.statusCode === 404 ? 'debug' : 'warn';
      logger[level](`PCE ${pce}: no temperature available (${err.message})`);
    }
  }

  // Publishing is paced (300 states/minute at the host API), so importing a
  // long history takes minutes. Commit the cursor as we go, slice by slice:
  // a failure halfway through then costs the remaining days, not the whole
  // import — otherwise every attempt would restart from the first day and a
  // history long enough to fail could never complete.
  const pacedPublisher = publisher ?? new StatePublisher();
  let days = 0;
  let states = 0;
  let newLastDay = lastDay;

  for (const slice of chunk(readings, DAYS_PER_COMMIT)) {
    const sliceStates = buildStates(gladys, pce, slice);
    await pacedPublisher.publish(gladys, sliceStates);

    days += slice.length;
    states += sliceStates.length;
    newLastDay = slice[slice.length - 1].day;
    store.set(pce, newLastDay);
    await store.save();

    if (readings.length > DAYS_PER_COMMIT) {
      logger.info(`PCE ${pce}: ${days}/${readings.length} day(s) imported (up to ${newLastDay})`);
    }
  }

  logger.info(`PCE ${pce}: ${days} day(s) published, up to ${newLastDay}`);
  return { pce, days, states, lastDay: newLastDay };
}

/**
 * Synchronize every metering point, one after the other. A meter that fails
 * does not prevent the others from being synchronized: the error is collected
 * and reported to the caller.
 *
 * @returns {Promise<{ days: number, states: number, waiting: number, errors: Array<{ pce: string, message: string }> }>}
 */
export async function synchronizeAll(
  gladys,
  { client, config, store, pceEntries, throttle, publisher, now },
) {
  const summary = { days: 0, states: 0, waiting: 0, errors: [] };
  // One budget for the whole pass: two meters importing their history together
  // must not each believe they own the full states-per-minute allowance.
  const sharedPublisher = publisher ?? new StatePublisher();
  // Asked once for the whole pass, not once per meter.
  const createdDevices = await gladys.getDevices();

  for (const pceEntry of pceEntries) {
    try {
      const result = await synchronizePce(gladys, {
        client,
        config,
        store,
        pceEntry,
        throttle,
        publisher: sharedPublisher,
        createdDevices,
        now,
      });
      summary.days += result.days;
      summary.states += result.states;
      if (result.skipped === 'not-created') {
        summary.waiting += 1;
      }
    } catch (err) {
      logger.error(`PCE ${pceEntry.pce}: synchronization failed`, err);
      summary.errors.push({ pce: String(pceEntry.pce), message: err.message });
    }
  }

  return summary;
}
