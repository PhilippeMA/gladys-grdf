import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/grdf/cookieJar.js';

/** A response-like object exposing only what the jar reads. */
function responseWith(setCookies) {
  return {
    headers: {
      getSetCookie: () => setCookies,
      get: () => setCookies.join(', '),
    },
  };
}

test('a cookie is sent back to the host that set it', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/api', responseWith(['auth_token=abc']));
  assert.equal(jar.header('https://monespace.grdf.fr/api/e-conso/pce'), 'auth_token=abc');
});

test('a cookie is not sent to an unrelated host', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=abc']));
  assert.equal(jar.header('https://example.com/'), '');
});

test('a Domain attribute widens the cookie to the sub-domains', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(
    'https://connexion.grdf.fr/',
    responseWith(['session=xyz; Domain=.grdf.fr; Path=/']),
  );
  assert.equal(jar.header('https://monespace.grdf.fr/api'), 'session=xyz');
  assert.equal(jar.header('https://connexion.grdf.fr/idp'), 'session=xyz');
});

test('the Path attribute is honoured', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://connexion.grdf.fr/', responseWith(['idx=1; Path=/idp']));
  assert.equal(jar.header('https://connexion.grdf.fr/idp/idx/identify'), 'idx=1');
  assert.equal(jar.header('https://connexion.grdf.fr/oauth2'), '');
});

test('several cookies are joined in one header', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['a=1', 'b=2']));
  const header = jar.header('https://monespace.grdf.fr/');
  assert.ok(header.includes('a=1'));
  assert.ok(header.includes('b=2'));
  assert.ok(header.includes('; '));
});

test('a later value replaces the previous one', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=old']));
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=new']));
  assert.equal(jar.header('https://monespace.grdf.fr/'), 'auth_token=new');
});

test('a cookie deleted by the server disappears', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=abc']));
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=; Max-Age=0']));
  assert.equal(jar.header('https://monespace.grdf.fr/'), '');

  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=abc']));
  jar.storeFromResponse(
    'https://monespace.grdf.fr/',
    responseWith(['auth_token=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']),
  );
  assert.equal(jar.header('https://monespace.grdf.fr/'), '');
});

test('a cookie value containing an equals sign is kept whole', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['token=a=b=c; Path=/']));
  assert.equal(jar.get('token'), 'a=b=c');
});

test('a malformed Set-Cookie is ignored instead of poisoning the jar', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['garbage', '=novalue']));
  assert.equal(jar.header('https://monespace.grdf.fr/'), '');
});

test('a cookie can be set by hand, as the login flow needs', () => {
  const jar = new CookieJar();
  jar.set('ln', 'user@example.com', { domain: 'grdf.fr' });
  assert.equal(jar.header('https://connexion.grdf.fr/idp/idx/identify'), 'ln=user@example.com');
});

test('get finds a cookie whatever host set it, and clear empties the jar', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://monespace.grdf.fr/', responseWith(['auth_token=abc']));
  assert.equal(jar.get('auth_token'), 'abc');
  assert.equal(jar.get('missing'), undefined);
  jar.clear();
  assert.equal(jar.get('auth_token'), undefined);
});
