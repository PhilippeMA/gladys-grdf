// -----------------------------------------------------------------------------
// Tests of the GRDF client, with `fetch` stubbed by a tiny router.
//
// The login flow is the part that breaks whenever GRDF changes its website, so
// it is worth pinning down: what we send, in which order, and how each failure
// is reported to the user.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSUMPTION_TYPES,
  GrdfAuthError,
  GrdfClient,
  GrdfHttpError,
  extractOktaErrorMessage,
  extractStateToken,
} from '../src/grdf/client.js';

const LOGIN_PAGE_HTML = `<!doctype html><html><head><script>
  var oktaData = {"signIn":{"stateToken":"02.id.abc\\x2Ddef\\x2D123"}};
</script></head><body></body></html>`;

function jsonResponse(body, { status = 200, cookies = [] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function htmlResponse(body, { status = 200, cookies = [] } = {}) {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(body, { status, headers });
}

function redirectResponse(location, { cookies = [] } = {}) {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

/**
 * Install a fake `fetch` routing on the request URL. Each route is a function
 * receiving `(url, options, callIndex)` and returning a Response.
 */
function stubFetch(t, routes) {
  const calls = [];
  const counters = new Map();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const route = Object.entries(routes).find(([pattern]) => url.startsWith(pattern));
    if (!route) {
      throw new Error(`Unexpected request: ${url}`);
    }
    const [pattern, handler] = route;
    const index = counters.get(pattern) ?? 0;
    counters.set(pattern, index + 1);
    return handler(url, options, index);
  };
  return calls;
}

/** The happy-path routes of the whole login flow. */
function loginRoutes(overrides = {}) {
  return {
    'https://monespace.grdf.fr/accueil': () =>
      htmlResponse('<html>logged in</html>', { cookies: ['auth_token=the-token; Path=/'] }),
    // The session warm-up the client runs at the end of every login.
    'https://monespace.grdf.fr/api/e-connexion/users/whoami': () => jsonResponse({ id: 1 }),
    'https://monespace.grdf.fr/api': () => jsonResponse([]),
    'https://monespace.grdf.fr/': () =>
      htmlResponse(LOGIN_PAGE_HTML, { cookies: ['JSESSIONID=abc; Path=/'] }),
    'https://connexion.grdf.fr/idp/idx/identify': () => jsonResponse({ stateHandle: 'handle-1' }),
    'https://connexion.grdf.fr/idp/idx/challenge/answer': () =>
      jsonResponse({ success: { href: 'https://connexion.grdf.fr/login/token/redirect' } }),
    'https://connexion.grdf.fr/login/token/redirect': () =>
      redirectResponse('https://monespace.grdf.fr/accueil'),
    ...overrides,
  };
}

/** How many full login flows the recorded calls contain. */
function logins(calls) {
  return calls.filter((call) => call.url.endsWith('/idp/idx/identify')).length;
}

function createClient(overrides = {}) {
  return new GrdfClient({
    email: 'user@example.com',
    password: 'secret',
    retryDelayMs: 0,
    ...overrides,
  });
}

test('extractStateToken reads the token out of the login page and unescapes it', () => {
  assert.equal(extractStateToken(LOGIN_PAGE_HTML), '02.id.abc-def-123');
});

test('extractStateToken fails loudly when GRDF changes its login page', () => {
  assert.throws(() => extractStateToken('<html>nothing here</html>'), GrdfAuthError);
});

test('extractOktaErrorMessage digs the reason out of the error payloads', () => {
  assert.equal(
    extractOktaErrorMessage({ messages: { value: [{ message: 'Bad password' }] } }),
    'Bad password',
  );
  assert.equal(extractOktaErrorMessage({ errorSummary: 'Account locked' }), 'Account locked');
  assert.equal(extractOktaErrorMessage({}), undefined);
  assert.equal(extractOktaErrorMessage(undefined), undefined);
});

test('the login walks the four steps and keeps the session cookie', async (t) => {
  const calls = stubFetch(t, loginRoutes());
  const client = createClient();

  await client.login();

  assert.equal(client.isLoggedIn(), true);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      '/',
      '/idp/idx/identify',
      '/idp/idx/challenge/answer',
      '/login/token/redirect',
      '/accueil',
      '/api/e-connexion/users/whoami',
    ],
  );

  // The email is handed over first, the password only afterwards.
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    identifier: 'user@example.com',
    stateHandle: '02.id.abc-def-123',
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    credentials: { passcode: 'secret' },
    stateHandle: 'handle-1',
  });
  // The `ln` cookie the login page sets from JavaScript is sent too.
  assert.match(calls[1].options.headers.Cookie, /ln=user@example\.com/);
  // The session cookie collected on the redirect is kept for the API calls.
  assert.equal(client.jar.get('auth_token'), 'the-token');
});

test('logging in twice reuses the session', async (t) => {
  const calls = stubFetch(t, loginRoutes());
  const client = createClient();

  await client.login();
  await client.login();

  assert.equal(calls.length, 6);
});

test('concurrent logins share a single flow', async (t) => {
  const calls = stubFetch(t, loginRoutes());
  const client = createClient();

  await Promise.all([client.login(), client.login(), client.login()]);

  assert.equal(calls.length, 6);
});

test('a rejected password is reported with the reason GRDF gave', async (t) => {
  stubFetch(
    t,
    loginRoutes({
      'https://connexion.grdf.fr/idp/idx/challenge/answer': () =>
        jsonResponse(
          { messages: { value: [{ message: 'Mot de passe incorrect' }] } },
          { status: 401 },
        ),
    }),
  );
  const client = createClient();

  await assert.rejects(client.login(), (err) => {
    assert.ok(err instanceof GrdfAuthError);
    assert.match(err.message, /HTTP 401/);
    assert.match(err.message, /Mot de passe incorrect/);
    return true;
  });
  assert.equal(client.isLoggedIn(), false);
});

test('an account asking for a second factor gets an explicit message', async (t) => {
  stubFetch(
    t,
    loginRoutes({
      // Okta answers 200 with a `remediation` block instead of `success`.
      'https://connexion.grdf.fr/idp/idx/challenge/answer': () =>
        jsonResponse({ remediation: { value: [{ name: 'challenge-authenticator' }] } }),
    }),
  );

  await assert.rejects(createClient().login(), (err) => {
    assert.ok(err instanceof GrdfAuthError);
    assert.match(err.message, /verification step/);
    return true;
  });
});

test('a login that ends without the session cookie is not silently accepted', async (t) => {
  stubFetch(
    t,
    loginRoutes({
      'https://monespace.grdf.fr/accueil': () => htmlResponse('<html>no cookie</html>'),
    }),
  );

  await assert.rejects(createClient().login(), GrdfAuthError);
});

test('missing credentials never reach the network', async (t) => {
  const calls = stubFetch(t, loginRoutes());
  await assert.rejects(new GrdfClient({ email: '', password: '' }).login(), GrdfAuthError);
  assert.equal(calls.length, 0);
});

test('a consumption request carries the dates and the bracketed PCE list', async (t) => {
  const calls = stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => jsonResponse({ '012': { releves: [] } }),
  });
  const client = createClient();

  const body = await client.getConsumption({
    pceList: ['012', '345'],
    startDate: '2026-08-01',
    endDate: '2026-08-07',
  });

  assert.deepEqual(body, { '012': { releves: [] } });
  const apiCall = calls.at(-1);
  const url = new URL(apiCall.url);
  assert.equal(url.pathname, `/api/e-conso/pce/consommation/${CONSUMPTION_TYPES.INFORMATIVE}`);
  assert.equal(url.searchParams.get('dateDebut'), '2026-08-01');
  assert.equal(url.searchParams.get('dateFin'), '2026-08-07');
  assert.equal(url.searchParams.get('pceList[]'), '012,345');
  assert.equal(apiCall.options.headers.domain, 'grdf.fr');
  assert.match(apiCall.options.headers.Cookie, /auth_token=the-token/);
});

test('an empty period comes back as an empty object, not an array', async (t) => {
  stubFetch(t, { ...loginRoutes(), 'https://monespace.grdf.fr/api': () => jsonResponse([]) });

  const body = await createClient().getConsumption({
    pceList: ['012'],
    startDate: '2026-08-01',
    endDate: '2026-08-07',
  });

  assert.deepEqual(body, {});
});

test('the HTML app shell is treated as a refused session: renew, then replay', async (t) => {
  const calls = stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': (_url, _options, index) =>
      index === 0 ? htmlResponse('<html>app shell</html>') : jsonResponse([{ pce: '012' }]),
  });

  const pces = await createClient().getPceList();

  assert.deepEqual(pces, [{ pce: '012' }]);
  // Retrying the same refused session leads nowhere: a fresh login happened.
  assert.equal(logins(calls), 2);
});

test('the login page served on an API call says the session was refused', async (t) => {
  stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => htmlResponse(LOGIN_PAGE_HTML),
  });

  await assert.rejects(createClient({ retryCount: 2 }).getPceList(), (err) => {
    assert.ok(err instanceof GrdfHttpError);
    assert.match(err.message, /login page/);
    assert.match(err.message, /session was not accepted/);
    return true;
  });
});

test('an endpoint that never answers JSON gives up with a clear error', async (t) => {
  stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => htmlResponse('<html>app shell</html>'),
  });

  await assert.rejects(createClient({ retryCount: 2 }).getPceList(), (err) => {
    assert.ok(err instanceof GrdfHttpError);
    assert.match(err.message, /HTML app shell/);
    return true;
  });
});

test('a redirect on an API call is diagnosed, not followed into an HTML page', async (t) => {
  const calls = stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': (_url, _options, index) =>
      index === 0
        ? redirectResponse('https://connexion.grdf.fr/oauth2/authorize')
        : jsonResponse([{ pce: '012' }]),
  });

  const pces = await createClient().getPceList();

  assert.deepEqual(pces, [{ pce: '012' }]);
  assert.equal(logins(calls), 2);
  // The redirect target was never fetched: it is the diagnosis, not a step.
  assert.equal(calls.filter((call) => call.url.includes('/oauth2/authorize')).length, 0);
});

test('a session refused for good stops after a bounded number of logins', async (t) => {
  const calls = stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => redirectResponse('https://connexion.grdf.fr/login'),
  });

  await assert.rejects(createClient({ retryCount: 4 }).getPceList(), (err) => {
    assert.match(err.message, /redirected/);
    return true;
  });
  // The initial login plus MAX_RELOGIN_PER_REQUEST renewals, then plain waits.
  assert.equal(logins(calls), 3);
});

test('an expired session triggers a new login and the call is replayed', async (t) => {
  const calls = stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': (_url, _options, index) =>
      index === 0
        ? jsonResponse({ message: 'expired' }, { status: 401 })
        : jsonResponse([{ pce: '012' }]),
  });
  const client = createClient();

  const pces = await client.getPceList();

  assert.deepEqual(pces, [{ pce: '012' }]);
  // Two full login flows: the initial one and the one after the 401.
  assert.equal(logins(calls), 2);
});

test('a server error is surfaced with its status code', async (t) => {
  stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => jsonResponse({ error: 'boom' }, { status: 500 }),
  });

  await assert.rejects(createClient().getPceList(), (err) => {
    assert.ok(err instanceof GrdfHttpError);
    assert.equal(err.statusCode, 500);
    return true;
  });
});

test('an unexpected payload for the PCE list is rejected', async (t) => {
  stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => jsonResponse({ not: 'an array' }),
  });

  await assert.rejects(createClient().getPceList(), GrdfHttpError);
});

test('the temperature window is clamped to what GRDF accepts', async (t) => {
  const calls = stubFetch(t, {
    ...loginRoutes(),
    'https://monespace.grdf.fr/api': () => jsonResponse({ '2026-08-01': 18.4 }),
  });
  const client = createClient();

  const temperatures = await client.getTemperatures({
    pce: '012',
    endDate: '2026-08-07',
    days: 5000,
  });

  assert.deepEqual(temperatures, { '2026-08-01': 18.4 });
  const url = new URL(calls.at(-1).url);
  assert.equal(url.pathname, '/api/e-conso/pce/012/meteo');
  assert.equal(url.searchParams.get('nbJours'), '365');
});

test('logout forces the next call to log in again', async (t) => {
  const calls = stubFetch(t, loginRoutes());
  const client = createClient();

  await client.login();
  client.logout();
  assert.equal(client.isLoggedIn(), false);
  assert.equal(client.jar.get('auth_token'), undefined);

  await client.login();
  assert.equal(calls.filter((call) => call.url.endsWith('/idp/idx/identify')).length, 2);
});
