// -----------------------------------------------------------------------------
// "Has the user actually added this meter to their home?"
//
// Publishing a discovered device does NOT create it: it only offers it in the
// Discovery screen, and the user decides. A state published for a device that
// was never created is dropped by the core, silently — `newStateEvent` logs
// "DeviceFeature not found (or not added to Gladys), skipping state update" on
// the SERVER side and answers success to us.
//
// That silence is a trap for an integration that imports history: it would
// happily "publish" a week of consumption two seconds after discovery, move its
// cursor past it, and never send those days again. So we ask Gladys what the
// user created, and treat anything else as "not ready yet".
// -----------------------------------------------------------------------------

/**
 * Look up a created device by its external id.
 * @param {Array<{ external_id?: string }>} devices what `gladys.getDevices()` returned
 * @param {string} externalId
 */
export function findCreatedDevice(devices, externalId) {
  if (!Array.isArray(devices)) {
    return undefined;
  }
  return devices.find((device) => device?.external_id === externalId);
}

/**
 * Does Gladys hold at least one value for this device?
 *
 * Used to catch a cursor that lies: if we believe we already published days
 * but the device has never held a single value, those states went nowhere
 * (published before the user created the device) and the history has to be
 * imported again.
 *
 * @param {{ features?: Array<{ last_value?: unknown, last_value_string?: unknown }> }} device
 */
export function hasAnyValue(device) {
  const features = device?.features;
  if (!Array.isArray(features)) {
    return false;
  }
  return features.some(
    (feature) =>
      (feature?.last_value !== null && feature?.last_value !== undefined) ||
      (feature?.last_value_string !== null && feature?.last_value_string !== undefined),
  );
}
