// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in the Gladys Configuration screen, from the
// `config_schema` declared in `gladys-assistant-integration.json`. The SDK
// fetches it (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module owns the defaults and normalizes the received object, so the rest
// of the code never deals with `undefined`, with numbers arriving as strings
// from the form, or with out-of-range values.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a test enforces it).
export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  // Empty means "every PCE the account has access to".
  pce_list: '',
  // Days of history fetched on the very first run (and after a data gap).
  history_days: 7,
  // GRDF publishes a meter reading once a day, around noon for the day before.
  // Polling every 6 hours is plenty and stays polite with their servers.
  poll_frequency: 21600,
};

const LIMITS = {
  history_days: { min: 1, max: 1095 },
  poll_frequency: { min: 3600, max: 86400 },
};

/**
 * Coerce to a number, fall back to the default, then clamp to the field range.
 */
function normalizeNumber(key, rawValue) {
  const fallback = DEFAULT_CONFIG[key];
  const { min, max } = LIMITS[key];
  // `Number(null)` and `Number('')` are 0: an empty field means "not set", not
  // "zero", so those must reach the default instead of being clamped to `min`.
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Merge the user configuration with the defaults.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    pce_list: String(raw.pce_list ?? DEFAULT_CONFIG.pce_list),
    history_days: normalizeNumber('history_days', raw.history_days),
    poll_frequency: normalizeNumber('poll_frequency', raw.poll_frequency),
  };
}

/**
 * Parse the optional PCE filter: a free-text list of 14-digit metering point
 * identifiers, separated by anything the user finds natural (comma, semicolon,
 * space, newline). An empty result means "no filter".
 * @param {string} raw
 * @returns {string[]}
 */
export function parsePceList(raw) {
  return String(raw ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Is the configuration complete enough to talk to GRDF?
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return config.email.length > 0 && config.password.length > 0;
}
