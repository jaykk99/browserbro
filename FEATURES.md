# browserbro — "all it does, totally free"

A feature-by-feature map: Browserbase vs browserbro. Honest gaps are listed,
not hidden.

## Sessions

| Browserbase | browserbro | Notes |
|---|---|---|
| Create / list / get / delete sessions | Yes | Real Chromium contexts, REST API |
| Session state (cookies, storage) | Yes | Persistent contexts: profile dir under `data/profiles/` survives restarts |
| Contexts (isolated browser profiles) | Yes | Each session is its own context; persistent ones keep a named profile |
| Concurrent sessions | Yes, cloud scale | browserbro: limited by your machine's RAM/CPU |

## Live view

| Browserbase | browserbro | Notes |
|---|---|---|
| Live view (watch the browser) | Yes | Dashboard polls `GET /live` every second; each call is a fresh real screenshot |
| Live view URL / embed | Partial gap | No shareable public live-view URL — the dashboard is local only unless you expose the port yourself |

## Replay

| Browserbase | browserbro | Notes |
|---|---|---|
| Session replay | Yes | Frames captured every 500 ms, stitched to a real MP4 with ffmpeg |
| Replay download | Yes | `GET /api/sessions/:id/replay` returns the MP4 |
| Gap | — | No cloud-hosted replay player; you get the MP4 file itself |

## Actions

| Browserbase | browserbro | Notes |
|---|---|---|
| Navigate | Yes | Real navigation, waits for DOM content |
| Click | Yes | CSS selector, real mouse click in Chromium |
| Type / fill | Yes | `type` fills an input, optional Enter submit |
| Scroll | Yes | `scroll {y}` |
| Evaluate JS | Yes | `evaluate {expression}` |
| Wait | Yes | `wait {ms}` |
| Get title / text / links | Yes | Real DOM reads |
| Cookies / localStorage | Yes | Real context cookies and page localStorage |

## Screenshots / PDF

| Browserbase | browserbro | Notes |
|---|---|---|
| Screenshot (PNG) | Yes | Full-page-viewport PNG from the real page |
| PDF export | Yes | A4 PDF from the real page |

## Downloads / uploads

| Browserbase | browserbro | Notes |
|---|---|---|
| Download files | Yes | Server-side fetch through the same egress proxy, saved to `data/downloads/` (page-click, browser request stack, and CDP download behavior were all tried first and fail in this environment — see README). Limitation: does not carry the session's cookies. |
| Upload files | Yes | Multipart upload into a page file input, under the file's real name |

## Search / fetch

| Browserbase | browserbro | Notes |
|---|---|---|
| Search | Yes, keyless | DuckDuckGo HTML first, then Bing HTML, server-side fetch with a desktop UA; real browser navigation as a last resort. No API key. |
| Fetch (get page content) | Yes | Real browser navigation, returns title + text |
| Gap | — | No built-in SERP API credits; DuckDuckGo can serve a 202 "anomaly" page to some egress IPs, which is why Bing is the fallback. |

## Proxies

| Browserbase | browserbro | Notes |
|---|---|---|
| Proxy support | Yes | Set `BROWSERBRO_PROXY` (or `HTTP_PROXY`/`HTTPS_PROXY`); passed to Chromium |
| Residential / rotating proxies | Gap | You bring your own proxy; browserbro ships no proxy pool |

## Limits / pricing

| Browserbase | browserbro |
|---|---|
| Free plan: 60 min browser time / month, 3 agent runs, 1,000 search + 1,000 fetch calls, resets monthly, then pay | $0 forever. No minutes, no credits, no card. Limit is your own machine. |
| Cloud, scales, no local install | Local only. You run the machine, you keep it up. |
| API key required | No key at all. Nothing to leak. |

## What browserbro does NOT do

- No cloud hosting, no public URL out of the box (put it behind your own
  tunnel / VPS if you need one).
- No SMS 2FA, CAPTCHA solving, or phone verification bypass. Sites that
  demand them still demand them.
- No stealth / anti-bot fingerprinting. It is plain headless Chromium.
- Multi-user auth is one shared operator token (`BROWSERBRO_TOKEN`) plus
  per-buyer Monico access codes (`BROWSERBRO_HUB_URL`, product `browserbro`).
  A code only opens the API when its Monico grant names BrowserBro; there
  is no per-buyer metering or session quota yet.
- No AI agent loop built in. It is the browser layer; your agent calls
  the REST API.
