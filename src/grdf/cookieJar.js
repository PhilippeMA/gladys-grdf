// -----------------------------------------------------------------------------
// Minimal cookie jar for the built-in `fetch`.
//
// The GRDF login is a browser flow: the session is carried by cookies set
// across several hosts (`connexion.grdf.fr` for the Okta login, then
// `monespace.grdf.fr` for the `auth_token` that authenticates the API calls).
// Node's `fetch` does NOT store cookies, so we keep a small jar ourselves
// rather than pulling a dependency in.
//
// Scope: exactly what the GRDF flow needs — name/value, Domain, Path, and
// deletion through `Max-Age<=0` / an expired `Expires`. No public-suffix
// checks, no `Secure`/`SameSite` semantics: every request we make is https and
// stays inside `grdf.fr`.
// -----------------------------------------------------------------------------

/**
 * Does `host` belong to `domain`? (exact host, or a sub-domain of it)
 * @param {string} host hostname of the request
 * @param {string} domain domain of the stored cookie
 */
function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Does `path` fall under the cookie `cookiePath`? (RFC 6265 §5.1.4)
 */
function pathMatches(path, cookiePath) {
  if (cookiePath === '/' || path === cookiePath) {
    return true;
  }
  return path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

/**
 * Read the `Set-Cookie` headers of a response. `Headers.getSetCookie()` is the
 * only correct way to do it (several cookies can share the header name and
 * their values contain commas); the fallback covers older runtimes.
 * @param {Headers} headers
 * @returns {string[]}
 */
function readSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

export class CookieJar {
  constructor() {
    /** @type {Map<string, { name: string, value: string, domain: string, path: string }>} */
    this.cookies = new Map();
  }

  /**
   * Store a cookie by hand (the GRDF login expects an `ln` cookie holding the
   * email address, which no response ever sets).
   */
  set(name, value, { domain, path = '/' }) {
    this.cookies.set(`${domain}|${path}|${name}`, { name, value, domain, path });
  }

  /**
   * Absorb every `Set-Cookie` of a response.
   * @param {string} requestUrl URL the response comes from (defaults of the
   *   Domain/Path attributes are derived from it)
   * @param {Response} response
   */
  storeFromResponse(requestUrl, response) {
    const url = new URL(requestUrl);
    for (const header of readSetCookieHeaders(response.headers)) {
      this.#storeOne(url, header);
    }
  }

  /**
   * Value of the `Cookie` header to send to `requestUrl`, or an empty string
   * when no cookie matches.
   * @param {string} requestUrl
   */
  header(requestUrl) {
    const url = new URL(requestUrl);
    return [...this.cookies.values()]
      .filter(
        (cookie) =>
          domainMatches(url.hostname, cookie.domain) && pathMatches(url.pathname, cookie.path),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  /**
   * Value of a single cookie, whichever domain set it (used to read the
   * `auth_token` the login flow ends with).
   */
  get(name) {
    for (const cookie of this.cookies.values()) {
      if (cookie.name === name) {
        return cookie.value;
      }
    }
    return undefined;
  }

  clear() {
    this.cookies.clear();
  }

  /** Parse and store ONE `Set-Cookie` header. */
  #storeOne(url, header) {
    const [pair, ...attributes] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator < 1) {
      return; // malformed, ignore
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();

    let domain = url.hostname;
    let path = '/';
    let expired = false;

    for (const attribute of attributes) {
      const index = attribute.indexOf('=');
      const key = (index === -1 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const attributeValue = index === -1 ? '' : attribute.slice(index + 1).trim();

      if (key === 'domain' && attributeValue) {
        domain = attributeValue.replace(/^\./, '').toLowerCase();
      } else if (key === 'path' && attributeValue.startsWith('/')) {
        path = attributeValue;
      } else if (key === 'max-age' && Number(attributeValue) <= 0) {
        expired = true;
      } else if (key === 'expires' && attributeValue) {
        const expires = Date.parse(attributeValue);
        if (!Number.isNaN(expires) && expires <= Date.now()) {
          expired = true;
        }
      }
    }

    const storeKey = `${domain}|${path}|${name}`;
    if (expired) {
      this.cookies.delete(storeKey);
    } else {
      this.cookies.set(storeKey, { name, value, domain, path });
    }
  }
}
