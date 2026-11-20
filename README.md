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
