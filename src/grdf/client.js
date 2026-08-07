// -----------------------------------------------------------------------------
// GRDF "Mon Espace" client.
//
// GRDF publishes no public API for individuals: the data shown on
// https://monespace.grdf.fr is served by the private JSON endpoints the web app
// itself calls. This client reproduces exactly what a browser does:
//
//   1. GET https://monespace.grdf.fr/ -> the Okta login page, which embeds a
//      `stateToken` in its HTML;
//   2. POST /idp/idx/identify         -> hands over the email, gets a
//      `stateHandle` (Okta Identity Engine pipeline);
//   3. POST /idp/idx/challenge/answer -> hands over the password, gets the
//      `success` URL of the flow;
//   4. GET <success URL>              -> the redirect chain ends on
//      monespace.grdf.fr and drops the `auth_token` cookie;
//   5. GET /api/e-conso/...           -> the JSON endpoints, authenticated by
//      that cookie.
//
// It is therefore a scraper, and GRDF can break it at any time (this is exactly
// what happens to every Gazpar client out there). Failures are surfaced with an
// explicit message rather than swallowed, so the Configuration screen can tell
// the user what to do.
//
// Node 20+ provides `fetch` natively: no HTTP dependency. Cookies are handled
// by our own small jar (see cookieJar.js) since `fetch` ignores them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { CookieJar } from './cookieJar.js';

const logger = createLogger({ name: 'grdf-client' });

const START_URL = 'https://monespace.grdf.fr/';
const IDENTIFY_URL = 'https://connexion.grdf.fr/idp/idx/identify';
const CHALLENGE_ANSWER_URL = 'https://connexion.grdf.fr/idp/idx/challenge/answer';
const API_BASE_URL = 'https://monespace.grdf.fr/api';

// The endpoints answer differently to a "browser-looking" client; the Okta
// pipeline also expects its own versioned Accept header.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const OKTA_HEADERS = {
  Accept: 'application/json; okta-version=1.0.0',
  'Content-Type': 'application/json',
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;

/** Consumption datasets exposed by GRDF. */
export const CONSUMPTION_TYPES = {
  // Daily readings, the detailed ones shown in the web app.
  INFORMATIVE: 'informatives',
  // The readings sent to the gas supplier, used for billing.
  PUBLISHED: 'publiees',
};

/** An HTTP error returned by GRDF, carrying the status so callers can react. */
export class GrdfHttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'GrdfHttpError';
    this.statusCode = statusCode;
  }
}

/** Login refused (bad credentials, MFA, captcha…): retrying will not help. */
export class GrdfAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GrdfAuthError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Okta escapes the state token inside the HTML page (`\x2D` for `-`).
 * Decode every `\xNN` sequence rather than the single case we know about.
 */
function decodeHtmlEscapes(value) {
  return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Extract the `stateToken` embedded in the login page.
 * Exported for the tests: this regex is the most fragile part of the flow.
 * @param {string} html
 * @returns {string}
 */
export function extractStateToken(html) {
  const match = /"stateToken"\s*:\s*"([^"]+)"/.exec(html);
  if (!match) {
    throw new GrdfAuthError(
      'Could not find the login state token in the GRDF page. GRDF probably changed its login flow.',
    );
  }
  return decodeHtmlEscapes(match[1]);
}

/**
 * Best-effort human-readable reason out of an Okta error payload.
 * @param {unknown} body parsed JSON body (may be anything)
 */
export function extractOktaErrorMessage(body) {
  const values = body?.messages?.value;
  if (Array.isArray(values) && values.length > 0 && values[0]?.message) {
    return values.map((entry) => entry.message).join(' ');
  }
  if (typeof body?.errorSummary === 'string') {
    return body.errorSummary;
  }
  return undefined;
}

export class GrdfClient {
  /**
   * @param {{ email: string, password: string, retryCount?: number, retryDelayMs?: number }} options
   */
  constructor({ email, password, retryCount = 3, retryDelayMs = 3000 }) {
    this.email = email;
    this.password = password;
    this.retryCount = retryCount;
    this.retryDelayMs = retryDelayMs;
    this.jar = new CookieJar();
    this.loggedIn = false;
    /** In-flight login, so concurrent calls share one flow. @type {Promise<void>|undefined} */
    this.loginPromise = undefined;
  }

  /** Are we holding a session? (no server round-trip) */
  isLoggedIn() {
    return this.loggedIn;
  }

  /** Drop the session; the next call logs in again. */
  logout() {
    this.jar.clear();
    this.loggedIn = false;
  }

  /**
   * Run the full browser login flow and keep the resulting session cookies.
   * Idempotent, and safe to call concurrently: parallel callers (several
   * meters polled at once) share the same in-flight flow instead of racing
   * three logins through the Okta pipeline.
   */
  async login() {
    if (this.loggedIn) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.#login().finally(() => {
        this.loginPromise = undefined;
      });
    }
    await this.loginPromise;
  }

  async #login() {
    if (!this.email || !this.password) {
      throw new GrdfAuthError('Email and password are required to connect to GRDF.');
    }

    logger.debug('Login step 1/4: loading the GRDF login page');
    const startResponse = await this.#fetch(START_URL);
    if (!startResponse.ok) {
      throw new GrdfHttpError(
        `GRDF login page returned HTTP ${startResponse.status}`,
        startResponse.status,
      );
    }
    const stateToken = extractStateToken(await startResponse.text());

    // The login page sets this one from JavaScript; the pipeline expects it.
    this.jar.set('ln', this.email, { domain: 'grdf.fr' });

    logger.debug('Login step 2/4: identifying the account');
    const identifyBody = await this.#postJson(IDENTIFY_URL, {
      identifier: this.email,
      stateHandle: stateToken,
    });
    const stateHandle = identifyBody?.stateHandle;
    if (!stateHandle) {
      throw new GrdfAuthError(
        'GRDF did not return a login state handle. The account may be unknown, or the login flow changed.',
      );
    }

    logger.debug('Login step 3/4: answering the password challenge');
    const challengeBody = await this.#postJson(CHALLENGE_ANSWER_URL, {
      credentials: { passcode: this.password },
      stateHandle,
    });
    const successUrl = challengeBody?.success?.href;
    if (!successUrl) {
      // A `remediation` block instead of `success` means GRDF wants another
      // step (one-time code, captcha…), which this integration cannot answer.
      throw new GrdfAuthError(
        'GRDF did not complete the login after the password. Check your credentials, and note that ' +
          'accounts asking for an additional verification step (one-time code, captcha) are not supported.',
      );
    }

    logger.debug('Login step 4/4: following the session redirect');
    const redirectResponse = await this.#fetch(successUrl);
    if (!redirectResponse.ok) {
      throw new GrdfHttpError(
        `GRDF session redirect returned HTTP ${redirectResponse.status}`,
        redirectResponse.status,
      );
    }

    if (!this.jar.get('auth_token')) {
      throw new GrdfAuthError(
        'GRDF did not deliver an authentication cookie at the end of the login flow.',
      );
    }

    this.loggedIn = true;
    logger.info('Logged in to GRDF');
  }

  /**
   * Authenticated GET on the GRDF API, returning the parsed JSON.
   *
   * Two quirks are handled here, both observed in production:
   *   - the API sometimes answers with the HTML app shell instead of JSON
   *     (transient): retried a few times;
   *   - an expired session answers 401/403: we log in again once and replay.
   *
   * @param {string} endpoint path under /api, e.g. '/e-conso/pce'
   * @param {Record<string, string|number|boolean>} params query string
   */
  async get(endpoint, params = {}) {
    await this.login();

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      search.append(key, String(value));
    }
    const query = search.toString();
    const url = `${API_BASE_URL}${endpoint}${query ? `?${query}` : ''}`;

    let lastError;
    for (let attempt = 1; attempt <= this.retryCount; attempt += 1) {
      const response = await this.#fetch(url, {
        headers: { Accept: 'application/json', domain: 'grdf.fr' },
      });

      if (response.status === 401 || response.status === 403) {
        // Session lost: force a new login, then let the loop replay the call.
        logger.warn(`GRDF answered HTTP ${response.status} on ${endpoint}, logging in again`);
        this.logout();
        await this.login();
        lastError = new GrdfHttpError(
          `GRDF answered HTTP ${response.status} on ${endpoint}`,
          response.status,
        );
        continue;
      }

      if (!response.ok) {
        throw new GrdfHttpError(
          `GRDF answered HTTP ${response.status} on ${endpoint}`,
          response.status,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        lastError = new GrdfHttpError(
          `GRDF answered HTML instead of JSON on ${endpoint} (query: ${query})`,
          response.status,
        );
        logger.warn(`${lastError.message}. Retrying (attempt ${attempt}/${this.retryCount})`);
        if (attempt < this.retryCount) {
          await sleep(this.retryDelayMs);
        }
        continue;
      }

      return response.json();
    }

    throw lastError ?? new GrdfHttpError(`GRDF request failed on ${endpoint}`, 500);
  }

  /**
   * List of the PCE (metering points) the account has access to.
   * @param {boolean} details include the technical/contract details
   */
  async getPceList(details = false) {
    const body = await this.get('/e-conso/pce', { details });
    if (!Array.isArray(body)) {
      throw new GrdfHttpError('Unexpected response for the PCE list (an array was expected)', 200);
    }
    return body;
  }

  /**
   * Daily consumption readings of one or more PCE.
   * @param {{ pceList: string[], startDate: string, endDate: string, type?: string }} options
   *   dates are `YYYY-MM-DD`
   * @returns {Promise<Record<string, { releves?: unknown[] }>>} keyed by PCE id
   */
  async getConsumption({ pceList, startDate, endDate, type = CONSUMPTION_TYPES.INFORMATIVE }) {
    const body = await this.get(`/e-conso/pce/consommation/${type}`, {
      dateDebut: startDate,
      dateFin: endDate,
      // GRDF expects the bracketed, comma-joined form.
      'pceList[]': pceList.join(','),
    });
    // No data for the period comes back as an empty array, not an empty object.
    if (Array.isArray(body)) {
      return {};
    }
    return body ?? {};
  }

  /**
   * Daily outside temperatures GRDF attaches to a metering point. Used as a
   * fallback: the readings themselves carry a `temperature`, but it is often
   * null while this endpoint still answers.
   * @param {{ pce: string, endDate: string, days: number }} options
   * @returns {Promise<Record<string, number>>} temperature keyed by `YYYY-MM-DD`
   */
  async getTemperatures({ pce, endDate, days }) {
    const body = await this.get(`/e-conso/pce/${encodeURIComponent(pce)}/meteo`, {
      dateFinPeriode: endDate,
      nbJours: Math.min(Math.max(Math.round(days), 1), 365),
    });
    // An empty period comes back as an empty array, not an empty object.
    if (Array.isArray(body)) {
      return {};
    }
    return body ?? {};
  }

  /** POST a JSON payload to the Okta pipeline and return the parsed answer. */
  async #postJson(url, payload) {
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: OKTA_HEADERS,
      body: JSON.stringify(payload),
    });

    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const reason = extractOktaErrorMessage(body);
      throw new GrdfAuthError(
        `GRDF login refused (HTTP ${response.status})${reason ? `: ${reason}` : ''}`,
      );
    }
    return body;
  }

  /**
   * `fetch` with the cookie jar plugged in.
   *
   * Redirects are followed by hand (`redirect: 'manual'`): the session cookies
   * are set on the intermediate hops of the login chain, and the automatic
   * redirect handling of `fetch` would drop them.
   */
  async #fetch(url, options = {}) {
    let currentUrl = url;
    let currentOptions = options;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const cookieHeader = this.jar.header(currentUrl);
      const response = await fetch(currentUrl, {
        ...currentOptions,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'User-Agent': USER_AGENT,
          ...(currentOptions.headers ?? {}),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      });

      this.jar.storeFromResponse(currentUrl, response);

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        // A redirect always continues as a GET without the original body.
        currentOptions = { ...currentOptions, method: 'GET', body: undefined };
        continue;
      }

      return response;
    }

    throw new GrdfHttpError(`Too many redirects while calling ${url}`, 508);
  }
}
