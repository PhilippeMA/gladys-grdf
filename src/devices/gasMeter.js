// -----------------------------------------------------------------------------
// Device type: GAZPAR GAS METER (one per PCE).
//
// A PCE ("Point de Comptage et d'Estimation") is the 14-digit identifier of a
// gas metering point. An account can hold several of them (a home and a rental,
// for instance), so devices are built dynamically from the list GRDF returns —
// there is no static device catalog here, unlike in the template.
//
// Every feature is read-only: GRDF exposes measurements, nothing controllable.
// States are published with the timestamp of their gas day (see dates.js), so
// the Gladys charts show the consumption on the day it happened even though it
// is only known one or two days later.
//
// Device names come from GRDF (the alias the user chose in Mon Espace) and the
// feature names are in French: GRDF is a French-only service, so its own
// vocabulary is what the user will recognize.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { gasDayTimestamp } from '../dates.js';

export const DEVICE_TYPE = 'gazpar';

/** Feature keys, kept in one place so discovery and publishing always agree. */
export const FEATURE = {
  DAILY_ENERGY: 'daily-energy',
  DAILY_VOLUME: 'daily-volume',
  INDEX: 'index',
  TEMPERATURE: 'temperature',
};

/**
 * External ids of the device carrying a PCE.
 * @param {object} gladys SDK instance
 * @param {string} pce metering point identifier
 */
export function externalIdsFor(gladys, pce) {
  return gladys.externalIds(DEVICE_TYPE, pce);
}

/** Device external_id of a PCE (used to route onPoll to the right meter). */
export function deviceExternalId(gladys, pce) {
  return externalIdsFor(gladys, pce).device;
}

/**
 * Human-readable name of the meter: the alias the user set in Mon Espace when
 * there is one, the PCE number otherwise.
 * @param {{ pce: string, alias?: string }} pceEntry entry of the GRDF PCE list
 */
export function buildDeviceName({ pce, alias }) {
  const trimmedAlias = typeof alias === 'string' ? alias.trim() : '';
  return trimmedAlias ? `Gazpar ${trimmedAlias}` : `Gazpar ${pce}`;
}

/**
 * Discovery payload of one meter.
 *
 * No `poll_frequency`: the core accepts only a closed list of values, in
 * MILLISECONDS, the slowest being one minute (DEVICE_POLL_FREQUENCIES) — meant
 * for a lamp on the LAN, not for a website publishing one measurement a day.
 * Declaring one would either be rejected or have Gladys wake us up every
 * minute, so this integration schedules its own refresh instead (see
 * index.js) at the interval the user configured, in hours.
 *
 * @param {object} gladys SDK instance
 * @param {{ pce: string, alias?: string }} pceEntry
 */
export function buildDevice(gladys, pceEntry) {
  const ids = externalIdsFor(gladys, pceEntry.pce);
  return {
    name: buildDeviceName(pceEntry),
    external_id: ids.device,
    features: [
      {
        name: 'Consommation quotidienne',
        external_id: ids.feature(FEATURE.DAILY_ENERGY),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: 10000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Volume quotidien',
        external_id: ids.feature(FEATURE.DAILY_VOLUME),
        category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
        type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CUBIC_METER,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        // A VOLUME sensor, not an energy index, although it is the meter's
        // cumulative reading. Gladys treats `energy-sensor`/`index` as a
        // cumulative ENERGY index: it derives a half-hourly consumption and
        // its cost from the deltas, and hangs the whole thing under the main
        // electric meter. Our index counts cubic metres of gas, so that
        // pipeline would bill m³ at the electricity price. The energy of this
        // meter has its own feature, in kWh, fed through the dated
        // consumption API — see src/gazpar.js.
        name: 'Index compteur',
        external_id: ids.feature(FEATURE.INDEX),
        category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
        type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CUBIC_METER,
        min: 0,
        max: 99999999,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Température extérieure moyenne',
        external_id: ids.feature(FEATURE.TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -50,
        max: 60,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/**
 * Turn clean readings into the batch payload of `publishStates`.
 *
 * The daily ENERGY is deliberately absent: it is the meter's consumption, and
 * Gladys takes that one through its dated-consumption API instead (see
 * `buildEnergyIntervals` and src/gazpar.js) so it can price it. Everything
 * else is a plain measurement and goes through the states path.
 *
 * A reading only produces the states it actually holds: a missing volume or a
 * missing temperature is skipped, never published as a zero.
 *
 * @param {object} gladys SDK instance
 * @param {string} pce metering point identifier
 * @param {ReturnType<import('../grdf/readings.js').normalizeReadings>} readings
 */
export function buildStates(gladys, pce, readings) {
  const ids = externalIdsFor(gladys, pce);
  const states = [];

  for (const reading of readings) {
    const created_at = gasDayTimestamp(reading.day);
    const push = (featureKey, value) => {
      if (value !== undefined) {
        states.push({
          device_feature_external_id: ids.feature(featureKey),
          state: value,
          created_at,
        });
      }
    };

    push(FEATURE.DAILY_VOLUME, reading.volume);
    push(FEATURE.INDEX, reading.endIndex);
    push(FEATURE.TEMPERATURE, reading.temperature);
  }

  return states;
}

/**
 * Turn clean readings into the intervals of `publishEnergyConsumption`.
 *
 * One entry per gas day, in kWh, dated by the day itself: Gladys resolves it
 * to the local midnight of its own timezone and owns the instant from there.
 * We no longer choose the timestamp — which is the point, since the core
 * needs the interval, not a state, to put a price on it.
 *
 * @param {ReturnType<import('../grdf/readings.js').normalizeReadings>} readings
 * @returns {Array<{ date: string, kwh: number }>}
 */
export function buildEnergyIntervals(readings) {
  return readings
    .filter((reading) => typeof reading.energy === 'number' && reading.energy >= 0)
    .map((reading) => ({ date: reading.day, kwh: reading.energy }));
}
