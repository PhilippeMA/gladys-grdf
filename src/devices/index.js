// -----------------------------------------------------------------------------
// Device registry.
//
// This integration has a single device type — a Gazpar gas meter — but an
// unknown NUMBER of them: one per PCE the GRDF account gives access to. The
// registry is therefore built from the PCE list fetched at runtime, instead of
// the static blueprint list of the template.
// -----------------------------------------------------------------------------

import { parsePceList } from '../config.js';
import { buildDevice, deviceExternalId } from './gasMeter.js';

export { DEVICE_TYPE, FEATURE, buildDevice, buildDeviceName, buildStates } from './gasMeter.js';

/**
 * Keep only the metering points the user asked for. An empty filter (the
 * default) keeps them all.
 *
 * @param {Array<{ pce: string }>} pceEntries entries returned by GRDF
 * @param {string} rawFilter the `pce_list` config value
 */
export function filterPces(pceEntries, rawFilter) {
  const wanted = parsePceList(rawFilter);
  if (wanted.length === 0) {
    return pceEntries;
  }
  const wantedSet = new Set(wanted);
  return pceEntries.filter((entry) => wantedSet.has(String(entry.pce)));
}

/**
 * Build the discovery payload: one device per metering point.
 * @param {object} gladys SDK instance
 * @param {Array<{ pce: string, alias?: string }>} pceEntries
 * @param {{ poll_frequency: number }} config
 */
export function buildDiscoveredDevices(gladys, pceEntries, config) {
  return pceEntries.map((entry) => buildDevice(gladys, entry, config));
}

/**
 * Which metering point does a Gladys device stand for?
 * Used to route `onPoll(device)` to the right meter.
 *
 * @param {object} gladys SDK instance
 * @param {Array<{ pce: string }>} pceEntries
 * @param {string} externalId device external_id received from Gladys
 */
export function findPceByExternalId(gladys, pceEntries, externalId) {
  return pceEntries.find((entry) => deviceExternalId(gladys, entry.pce) === externalId);
}
