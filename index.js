// -----------------------------------------------------------------------------
// Entry point of the GRDF Gazpar integration.
//
// Role of this file: wire the SDK to the GRDF client and the synchronization
// logic. It holds no protocol knowledge:
//   - src/grdf/    talks to GRDF (login, endpoints, response cleanup);
//   - src/devices/ describes the meters as Gladys devices;
//   - src/gazpar.js turns readings into published states.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import { buildDiscoveredDevices, filterPces, findPceByExternalId } from './src/devices/index.js';
import { synchronizeAll, synchronizePce } from './src/gazpar.js';
import { GrdfAuthError, GrdfClient } from './src/grdf/client.js';
import { StatePublisher } from './src/publisher.js';
import { SyncStore } from './src/store.js';
import { Throttle } from './src/throttle.js';

const gladys = new GladysIntegration();

/** Current configuration (hot-reloaded through onConfigUpdated). */
let config = normalizeConfig();

/** GRDF session; rebuilt whenever the credentials change. */
let client = null;

/** Metering points of the account, as returned by GRDF. */
let pceEntries = [];

/** Synchronization cursor, persisted in /data. */
const store = new SyncStore();

/**
 * Rate floor of the SCHEDULED path only. Whatever poll interval ends up being
 * applied, GRDF is never queried more than twice an hour for a given meter —
 * their daily data does not deserve more, and it is their website, not ours.
 */
const pollThrottle = new Throttle();

/**
 * Shared states budget: the host API accepts 300 states per minute for the
 * WHOLE integration, so a single publisher paces every meter (see publisher.js).
 */
const publisher = new StatePublisher();

/**
 * Our own refresh timer.
 *
 * Gladys can poll a device for us, but only at one of its predefined
 * frequencies — in milliseconds, one minute at the slowest. That scheduler is
 * built for hardware on the LAN; GRDF publishes one measurement per day. So the
 * devices declare no `poll_frequency` and we drive the refresh ourselves, at the
 * interval the user configured.
 */
let refreshTimer = null;

/**
 * GRDF is a slow, rate-sensitive website and Gladys can call us from several
 * directions at once (poll of two meters, an action, a config change). One
 * exchange at a time: the queue keeps the login flow and the API calls sane.
 */
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(task, task);
  // Keep the chain alive whatever happens to this task.
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Rebuild the GRDF client from the current configuration. */
function resetClient() {
  client = isConfigured(config)
    ? new GrdfClient({ email: config.email, password: config.password })
    : null;
}

/** Fetch the metering points of the account, filtered by the configuration. */
async function refreshPceList() {
  if (!client) {
    pceEntries = [];
    return pceEntries;
  }
  const allPces = await client.getPceList();
  pceEntries = filterPces(allPces, config.pce_list).map((entry) => ({
    ...entry,
    pce: String(entry.pce),
  }));
  logger.info(`${pceEntries.length} metering point(s) found on the GRDF account`);
  return pceEntries;
}

/** Publish the meters as discovered devices. */
async function publishDevices() {
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, pceEntries));
}

/** (Re)arm the refresh timer on the currently configured interval. */
function scheduleRefresh() {
  stopRefreshTimer();
  const intervalMs = config.poll_frequency * 1000;
  refreshTimer = setInterval(() => {
    enqueue(() =>
      synchronizeAll(gladys, {
        client,
        config,
        store,
        pceEntries,
        throttle: pollThrottle,
        publisher,
      }),
    ).catch((err) => logger.error('Scheduled refresh failed', err));
  }, intervalMs);
  logger.info(
    `Next GRDF refresh in ${config.poll_frequency}s, then every ${config.poll_frequency}s`,
  );
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Full pass: list the meters, publish them, import the new readings, and
 * report the application-level status shown in the Configuration screen.
 *
 * @param {{ force?: boolean }} options `force` when the user changed something
 *   and expects an immediate effect: the metering points are listed again and
 *   the rate floor is bypassed. Without it (a plain reconnection), the cached
 *   metering points are reused and the floor applies — a flapping WebSocket
 *   must not turn into a login storm on the GRDF website.
 */
async function initialize({ force = false } = {}) {
  if (!isConfigured(config)) {
    stopRefreshTimer();
    logger.warn('No GRDF credentials configured yet: waiting for the configuration');
    await gladys.setConnectionStatus(false, {
      en: 'Enter your GRDF account email and password in the configuration.',
      fr: 'Renseignez l’e-mail et le mot de passe de votre compte GRDF dans la configuration.',
    });
    return;
  }

  // Arm the timer even if this pass fails: a transient GRDF outage must not
  // leave the integration without a scheduler until the next restart.
  scheduleRefresh();

  try {
    if (force || pceEntries.length === 0) {
      await refreshPceList();
    }
    await publishDevices();
    const summary = await synchronizeAll(gladys, {
      client,
      config,
      store,
      pceEntries,
      throttle: force ? undefined : pollThrottle,
      publisher,
    });
    if (summary.errors.length > 0) {
      throw new Error(summary.errors.map((error) => `${error.pce}: ${error.message}`).join(' | '));
    }
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Synchronization with GRDF failed', err);
    await gladys.setConnectionStatus(false, connectionStatusMessage(err)).catch(() => {});
  }
}

/** Turn an error into the message shown under the connection status. */
function connectionStatusMessage(err) {
  if (err instanceof GrdfAuthError) {
    return {
      en: `GRDF login failed: ${err.message}`,
      fr: `Échec de la connexion à GRDF : ${err.message}`,
    };
  }
  return {
    en: 'Could not read the GRDF data, check the integration logs.',
    fr: 'Impossible de lire les données GRDF, consultez les logs de l’intégration.',
  };
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> refreshing the metering points');
  await enqueue(async () => {
    await refreshPceList();
    await publishDevices();
  });
});

// --- Polling: Gladys asks to refresh one meter -------------------------------
// The devices declare no `poll_frequency`, so this is not the normal refresh
// path (that one is our own timer): it only fires if Gladys ever asks for a
// device on demand. Kept, and throttled, because it costs nothing to honor.
gladys.onPoll(async (device) => {
  const pceEntry = findPceByExternalId(gladys, pceEntries, device.external_id);
  if (!pceEntry) {
    logger.warn(`onPoll ignored: no metering point matches ${device.external_id}`);
    return;
  }
  if (!client) {
    logger.warn('onPoll ignored: no GRDF credentials configured');
    return;
  }
  await enqueue(() =>
    synchronizePce(gladys, {
      client,
      config,
      store,
      pceEntry,
      throttle: pollThrottle,
      publisher,
    }),
  );
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  if (!isConfigured(config)) {
    throw new Error('Enter your GRDF email and password first.');
  }
  // A dedicated client: testing must not disturb (nor benefit from) the
  // session the integration is using.
  const testClient = new GrdfClient({ email: config.email, password: config.password });
  const pces = await enqueue(async () => {
    await testClient.login();
    return testClient.getPceList();
  });
  const matching = filterPces(pces, config.pce_list);
  const names = matching.map((entry) => entry.pce).join(', ') || '-';
  return {
    en: `Connection successful. ${matching.length} metering point(s) available: ${names}.`,
    fr: `Connexion réussie. ${matching.length} point(s) de comptage disponible(s) : ${names}.`,
  };
});

gladys.onAction('refresh_now', async () => {
  if (!client) {
    throw new Error('Enter your GRDF email and password first.');
  }
  const summary = await enqueue(async () => {
    await refreshPceList();
    await publishDevices();
    return synchronizeAll(gladys, { client, config, store, pceEntries, publisher });
  });
  if (summary.errors.length > 0) {
    throw new Error(summary.errors.map((error) => `${error.pce}: ${error.message}`).join(' | '));
  }
  if (summary.days === 0) {
    return {
      en: 'Already up to date: GRDF has no new reading (data is published one to two days late).',
      fr: 'Déjà à jour : GRDF n’a pas de nouveau relevé (les données arrivent avec un à deux jours de retard).',
    };
  }
  return {
    en: `${summary.days} new day(s) of consumption imported.`,
    fr: `${summary.days} nouvelle(s) journée(s) de consommation importée(s).`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  resetClient();
  await enqueue(() => initialize({ force: true }));
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// this handler only runs our own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    resetClient();
    await store.load();
    await enqueue(() => initialize());
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: 'L’initialisation a échoué, consultez les logs de l’intégration.',
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshTimer();
  client?.logout();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the GRDF Gazpar integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
