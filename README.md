# GRDF Gazpar — Gladys Assistant integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
reads the daily gas consumption of a **GRDF Gazpar** meter and publishes it as
Gladys devices.

Built on the official
[integration template](https://github.com/GladysAssistant/integration-template-js)
and the [JavaScript SDK](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [`docs/en.md`](./docs/en.md) · [`docs/fr.md`](./docs/fr.md).

## What it does

One Gladys device per **PCE** (metering point) of the GRDF account, each with
four read-only sensors:

| Feature                        | Category           | Unit |
| ------------------------------ | ------------------ | ---- |
| Consommation quotidienne       | energy sensor      | kWh  |
| Volume quotidien               | volume sensor      | m³   |
| Index compteur                 | energy sensor      | m³   |
| Température extérieure moyenne | temperature sensor | °C   |

Feature names are in French on purpose: GRDF is a French-only service and this
is the vocabulary its users recognize. Code and comments stay in English.

Each value is published with the timestamp of **its own gas day** (noon UTC of
the day it belongs to), not the time it was downloaded — GRDF publishes readings
one to two days late, and the charts must stay honest.

## How it talks to GRDF

GRDF has no public API for individuals, so the client reproduces the browser
login of [monespace.grdf.fr](https://monespace.grdf.fr):

1. `GET https://monespace.grdf.fr/` — the Okta login page, which embeds a
   `stateToken` in its HTML;
2. `POST /idp/idx/identify` — the email, which returns a `stateHandle`;
3. `POST /idp/idx/challenge/answer` — the password, which returns the `success`
   URL of the flow;
4. `GET <success URL>` — the redirect chain ends on `monespace.grdf.fr` and
   drops the `auth_token` cookie;
5. `GET /api/e-conso/…` — the JSON endpoints, authenticated by that cookie.

This is scraping: **GRDF can break it at any time**, and an account protected by
a one-time code or a captcha cannot be used. Every failure is surfaced with an
explicit message in the Configuration screen rather than swallowed.

Cookies are handled by a small in-repo jar ([`src/grdf/cookieJar.js`](./src/grdf/cookieJar.js))
because Node's `fetch` ignores them — the integration has no runtime dependency
beyond the Gladys SDK.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no GRDF logic)
├─ src/
│  ├─ grdf/
│  │  ├─ client.js                   #   login flow + JSON endpoints (+ retries)
│  │  ├─ cookieJar.js                #   minimal cookie jar for fetch
│  │  └─ readings.js                 #   cleanup of the raw GRDF readings
│  ├─ devices/
│  │  ├─ gasMeter.js                 #   one PCE -> one device + its features
│  │  └─ index.js                    #   registry (devices are dynamic)
│  ├─ gazpar.js                      # synchronization: readings -> states
│  ├─ publisher.js                   # paced publishing (host API rate limit)
│  ├─ throttle.js                    # rate floor of the scheduled path
│  ├─ store.js                       # sync cursor persisted in /data
│  ├─ dates.js                       # gas-day helpers
│  └─ config.js                      # config defaults + normalization
├─ docs/{en,fr}.md                   # user documentation, re-hosted by Gladys
├─ tools/generate-cover.js           # regenerates cover.png (no dependency)
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
└─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
```

### Scheduling and rate limits

Three constraints shape the pacing, all of them found in the Gladys core:

- **Gladys polling is not usable here.** `poll_frequency` accepts only a closed
  list of values (`DEVICE_POLL_FREQUENCIES`), in milliseconds, one minute at the
  slowest — a scheduler for hardware on the LAN. The devices declare none and
  the integration runs its own timer at the configured interval (6 h by
  default). `onPoll` is still handled, in case the core ever asks on demand.
- **300 states per minute, per integration.** Over that the host API answers
  429 and the batch is lost — the SDK does not retry. `StatePublisher` keeps a
  budget of 250 per minute (the core's window and ours are never aligned, so the
  margin absorbs the overlap) and waits for the next window instead of losing
  data. A full three-year import is therefore paced over ~18 minutes.
- **GRDF is somebody else's website.** A 30-minute floor per meter guards the
  scheduled path whatever interval ends up applied; the explicit "Refresh now"
  button bypasses it.

### Avoiding duplicates

GRDF answers with a whole period at once, so the integration keeps a cursor —
the last gas day published per PCE — in `/data/gazpar-state.json`, the only
writable location of the sandboxed container. On the first run it imports the
configured history (7 days by default, up to 3 years); afterwards it only asks
for what is new. If `/data` is not writable the integration keeps working, it
simply re-imports the history window after a restart.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="grdf-gazpar" \
GAZPAR_DATA_DIR="./data" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container; `GAZPAR_DATA_DIR` only exists to
keep the sync cursor out of `/data` while developing.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests, via the built-in `node --test` runner
```

The same three checks run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The tests cover the
login flow (with `fetch` stubbed), the cookie jar, the cleanup of the GRDF
payloads, the day arithmetic, the device mapping and the synchronization cursor
— no network, no GRDF account needed.

Before tagging a release, the store validation can be run locally:

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

1. Push this repository to GitHub, public, with the topic
   `gladys-assistant-integration`.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`: the
   workflow bumps the version everywhere (`package.json` + manifest
   `version`/`docker_image`), pushes the `vX.Y.Z` tag and builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new manifest version and Gladys offers
   a one-click install.

## License

Apache-2.0
