# browserbro

A self-hosted, totally free replacement for Browserbase. Real Chrome sessions
you run on your own machine. No API keys, no credits, no card, no cloud
minutes to burn.

## What it does

- **Real Chrome sessions** — create, list, get, delete. Persistent contexts
  keep cookies / localStorage in a profile folder that survives restarts.
- **Live view** — the dashboard shows a real-time screenshot stream of the
  session page (refreshes every second).
- **Replay** — records the session as screenshots and exports a real MP4
  (ffmpeg, included in the Docker image and present on most Linux boxes).
- **Actions** — navigate, click, type, scroll, wait, run JS, read title,
  text, links, cookies, localStorage.
- **Screenshots + PDF** — PNG screenshot and A4 PDF of the current page.
- **Downloads / uploads** — download a file to `data/downloads/`, upload a
  file into a page file input (see API.md for the exact mechanism and its
  one honest limitation: downloads fetch through the server, not the
  session's cookies).
- **Search + fetch, free and keyless** — search tries DuckDuckGo HTML then
  Bing HTML (server-side fetch, no API key), fetch loads the page in a real
  browser and returns its text.
- **Proxies** — optional `BROWSERBRO_PROXY` / `HTTP_PROXY` env var.
- **Dashboard UI** — one page to drive all of it, at `http://localhost:3101`.

See [FEATURES.md](FEATURES.md) for the honest Browserbase vs browserbro map,
and [API.md](API.md) for the full API reference.

## Quickstart

```bash
npm install
npx playwright install chromium   # downloads real Chromium once
npm start
# open http://localhost:3101
```

Port: `BROWSERBRO_PORT` (default `3101`). Data (profiles, downloads,
replays) lives in `./data/` and is git-ignored.

## Proxied environments

If your network forces an HTTP proxy (`HTTP_PROXY` / `HTTPS_PROXY`), set
`BROWSERBRO_PROXY` to it and browserbro passes it to Chromium. Two
gotchas, both handled:

- Some egress proxies drop an unauthenticated `CONNECT` instead of
  answering `407`, so Chromium never gets to send credentials. For that
  case run the included auth bridge first:
  `UPSTREAM_PROXY=$HTTPS_PROXY node proxy-bridge.js`
  then `BROWSERBRO_PROXY=http://127.0.0.1:3129 npm start`.
  `npm run smoke` does this automatically when a proxy env var is set.
- Proxies that MITM TLS need `--ignore-certificate-errors`, which
  browserbro adds automatically whenever a proxy is configured (opt out
  with `BROWSERBRO_IGNORE_CERTS=0`).

Chromium also needs temp space for shared-memory files. If `/tmp` is a
tiny tmpfs that fills up you get `ERR_INSUFFICIENT_RESOURCES`; the server
defaults `TMPDIR` to `./data/tmp` unless you set it yourself.

## Docker

```bash
docker compose up --build
# open http://localhost:3101
```

## Quick API test

```bash
curl -s localhost:3101/api/health
curl -s -X POST localhost:3101/api/sessions -H 'Content-Type: application/json' -d '{}'
# copy the id, then:
curl -s -X POST localhost:3101/api/sessions/<id>/navigate -H 'Content-Type: application/json' -d '{"url":"https://news.ycombinator.com"}'
curl -s localhost:3101/api/sessions/<id>/title
curl -s localhost:3101/api/sessions/<id>/screenshot -o shot.png
```

More in [examples/](examples/) and [API.md](API.md).

## Honest limits

- Local Chrome only, one machine. No cloud fleet, no 60-minute monthly
  allowance to run out of — but also no cloud scale. Sessions are limited
  by your own RAM/CPU.
- Search is DuckDuckGo HTML first, then Bing HTML, keyless. Some egress IPs
  get a 202 "anomaly" page from DuckDuckGo and an empty JS shell from Bing
  in-browser; the server-side HTML fetch path is what works there, and the
  endpoint falls back to real browser navigation. Either way it returns
  real results or an honest 502, never invented ones.
- Downloads fetch the file server-side through the same egress proxy (a
  page click, the browser request stack, and CDP download behavior were
  all tried and all fail in this environment: Chrome ignores the
  `download` attribute cross-origin, the request stack hangs up through
  the proxy, and no download event fires in headless shell). Limitation:
  the download does not carry the session's cookies.
- Uploads set a file into a real page file input. The smoke test uses the
  self-hosted form at `/test-upload.html` because the usual remote test
  site's subresources hang through this proxy; the mechanism is the same
  on any page.
- Navigating to a page whose subresources hang returns `loadState:
  "commit"` instead of failing outright; the response says which it was.
- Replay MP4 needs `ffmpeg` on the host (present in the Docker image).
- This is a browser, not an identity service: sites that demand SMS 2FA,
  CAPTCHAs, or a phone number will still demand them. browserbro does not
  bypass any of that.
- Nothing here is simulated. Every endpoint either does the real thing in a
  real Chrome, or returns an honest error (`404 session_not_found`,
  `502 navigation_failed`, ...). See [SMOKE.md](SMOKE.md) for the verified
  smoke run.

## Agent terminal (new)

Open **[Agent terminal](/terminal.html)** after starting the Node server at `http://localhost:3101`. The link also appears on the dashboard. Choose or create a session and enter `open https://example.org` to navigate through **the real Playwright Chromium session**, or `read`, `title`, `click 'button'`, `fill 'input[name=q]' 'hello'`, `press 'input[name=q]' Enter`, `scroll 500`, `screenshot` or `help`.

The terminal is also available to agents via the server's REST API:

```sh
curl -X POST http://localhost:3101/api/sessions/SESSION_ID/terminal -H 'Content-Type: application/json' -d '{"command":"open https://example.org"}'
curl http://localhost:3101/api/sessions/SESSION_ID/terminal/history
```

The terminal has per-session command history (last 80 actions) and bounded **virtual** text files (`write`, `cat`, `append`, `ls`, `rm`), not host Linux file access. Sessions and virtual files are not durable across service restart. It deliberately **does not execute arbitrary Linux shell commands**. This limits how much access a connected agent has to the host machine.

**Actual URL reachability:** BrowserBro's `open` command calls Playwright `page.goto`, retrieves the real title and displays the screenshot. If DNS, TLS, network, or the website fails, it returns an error rather than a fabricated result. To test public navigation on your own Linux instance, run `npm run smoke`, then manually try `open https://example.org` in the terminal. The test environment used for this update could not independently reach public DNS, so a live public-network result is not claimed.

**Security:** The current Node server's browser API does not require authentication. Run it only on a trusted local interface or behind a secure authenticated reverse proxy/VPN. Do not expose `/api/sessions` or `/api/sessions/:id/terminal` directly to the public internet. Agent terminal URL filtering is best-effort and is not a substitute for egress firewall restrictions.

Run the terminal unit tests with `npm run terminal-test`.


## Verify real public internet and URL loading

Run the independent **real-Chromium live test** on Linux (Node.js 22+ and Playwright Chromium installed):

```bash
npm ci
npx playwright install chromium
npm run terminal-test
npm run verify:public
```

The verification script starts an actual local BrowserBro server and a real Chromium session. It resolves the external public domains, runs the **agent terminal** `open https://example.com` and `open https://github.com`, reads both page titles and text, and validates real PNG screenshot bytes. It also checks the regular dashboard **Go** endpoint (`POST /api/sessions/:id/navigate`) with `https://example.org`, and confirms that an intentionally invalid domain yields a navigation error instead of fabricated success. A failing DNS, TLS, browser, or webpage check exits nonzero with diagnostics.

Every push to the relevant browser code runs the same live verification in [GitHub Actions](https://github.com/jaykk99/browserbro/actions/workflows/public-internet.yml) on Ubuntu 24.04, because the current Playwright version does not support Ubuntu 26.04. Passing GitHub Actions proves outbound HTTPS navigation **from the GitHub runner**. It does not prove that your own Chromebook has working DNS/proxy/firewall settings; run `npm run verify:public` on the Chromebook to check its actual network.

**Note:** This verifies outbound web browsing, not public inbound access to the BrowserBro dashboard. The current HTTP browser API is unauthenticated; do not expose it to the open internet without an authentication layer and an HTTPS reverse proxy.


## Verified one-command Linux startup

From your Linux checkout, use `npm run start:verified`. This command installs missing npm dependencies and Chromium, runs agent terminal unit tests, and **loads real HTTPS websites using a real BrowserBro Chromium session before starting the UI**. It fails visibly if DNS or outbound internet browsing is unavailable. The UI is at `http://localhost:3101/terminal.html`.

The API listens on `127.0.0.1` by default, because it is currently unauthenticated. Docker explicitly binds inside the container, with its published port restricted to the host loopback interface. Public tunnels should **not** be used without authorization and TLS protection.

GitHub Actions also tests both the Node and Docker production versions against live HTTPS URLs. The green CI run verifies internet access from GitHub's Linux workers; only running `npm run start:verified` on your Chromebook verifies the Chromebook's own network and browser dependencies.

## Agent City integration (Linux computers)

Agent City now has a same-host Node bridge at `/api/browser/status`,
`/api/browser/load`, and `/api/browser/search` (see
[Agents-city/BROWSERBRO.md](https://github.com/jaykk99/Agents-city/blob/main/BROWSERBRO.md)
after its integration PR is merged). Start BrowserBro on
`127.0.0.1:3101` and Agent City on `127.0.0.1:3000` on the **same
Linux host**. Agent City requests real Chromium pages, not an AI-generated
mockup.

For remote HTTPS gateways, enable server-side bearer authentication:

```sh
export BROWSERBRO_TOKEN="$(openssl rand -hex 32)"
npm start
```

Set the **same secret** on the Agent City backend as `BROWSERBRO_TOKEN`.
The secret is never sent to the Agent City web frontend. Keep the gateway
behind HTTPS and access controls. When auth is enabled, the standalone
BrowserBro dashboard needs an authenticated API client/proxy; its browser
JavaScript does not store or inject the bearer token.

To sell access instead of sharing one token, point the gateway at the
Monico shop hub and hand each buyer their own access code:

```sh
export BROWSERBRO_HUB_URL=https://monico-labs-hub.onrender.com
npm start
```

A buyer opens the dashboard once with `?code=ML-XXXX-XXXX-XXXX-XXXX` and
the code is kept in their browser and sent as `X-Access-Code` on every
API call. Only codes whose Monico grant names product `browserbro` open
the API; the operator token still works alongside. See `API.md`.

BrowserBro Pro costs **$19 one-time** in the [Monico Labs shop](https://monico-labs-insta.onrender.com/#/product/browserbro) and buys access to a hosted instance, signed in with the buyer's Monico access code. The hosted instance is not up yet, so the shop lists Pro as coming soon; the dashboard already links there and already accepts buyer codes.

Test token enforcement with `npm run auth-test`. A token authenticates the
caller, but is not a browser sandbox or an internet egress firewall.
