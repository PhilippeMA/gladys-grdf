// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface this integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
//   - publishDiscoveredDevices      -> record calls so tests can assert them
//   - setConnectionStatus           -> record calls so tests can assert them
// This lets us test the mapping and the synchronization logic without a
// running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys({ devices = null } = {}) {
  const published = [];
  const batches = [];
  const discoveredDevices = [];
  const connectionStatuses = [];

  return {
    published,
    batches,
    discoveredDevices,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      batches.push(states);
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
          created_at: state.created_at,
        });
      }
    },

    async publishDiscoveredDevices(discovered) {
      discoveredDevices.push(discovered);
      return { success: true, count: discovered.length };
    },

    // Devices the user actually created. `null` (the default) means "every
    // device the integration published", which keeps the tests that do not
    // care about creation readable; pass an array to control it.
    async getDevices() {
      if (devices !== null) {
        return devices;
      }
      return discoveredDevices.flat().map((device) => ({
        ...device,
        // A created device that already holds values, so the cursor is trusted.
        features: (device.features ?? []).map((feature) => ({ ...feature, last_value: 1 })),
      }));
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
