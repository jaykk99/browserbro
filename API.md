# browserbro API reference

Base URL: `http://localhost:3101` (or `$BROWSERBRO_PORT`). All JSON unless
noted. Errors are honest: `404 {ok:false, error:"session_not_found"}`,
`400` for a missing field, `502` when the real browser action failed.

## Health / limits

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ok, service, version, sessions, port}` |
| GET | `/api/limits` | Free-tier limits, all $0 |

## Sessions

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/sessions` | `{name?, persistent?, profile?}` | Create a real Chrome session. `persistent:true` uses a profile dir under `data/profiles/` that survives restarts. Returns `201 {ok, session}`. |
| GET | `/api/sessions` | — | List sessions |
| GET | `/api/sessions/:id` | — | Get one session (404 if unknown) |
| DELETE | `/api/sessions/:id` | — | Close the browser context. Persistent profiles are kept on disk (`profile_kept:true`) and can be re-opened with the same `profile` name. |

## Actions

| Method | Path | Body |
|---|---|---|
| POST | `/api/sessions/:id/navigate` | `{url}` |
| POST | `/api/sessions/:id/click` | `{selector}` — CSS selector, e.g. `a.storylink` |
| POST | `/api/sessions/:id/type` | `{selector, text, submit?}` — fills an input, Enter if `submit:true` |
| POST | `/api/sessions/:id/scroll` | `{y?}` — pixels, default 800 |
| POST | `/api/sessions/:id/wait` | `{ms?}` — max 60000 |
| POST | `/api/sessions/:id/evaluate` | `{expression}` — JS string, e.g. `document.title` or `1+1` |

## Reads

| Method | Path | Returns |
|---|---|---|
| GET | `/api/sessions/:id/url` | `{url}` |
| GET | `/api/sessions/:id/title` | `{title, url}` |
| GET | `/api/sessions/:id/text` | `{url, text}` (first 20,000 chars) |
| GET | `/api/sessions/:id/links` | `{count, links:[{text, href}]}` (first 200) |
| GET | `/api/sessions/:id/cookies` | `{cookies:[...]}` |
| GET | `/api/sessions/:id/localstorage` | `{localStorage:{...}}` |

## Screenshots / PDF / live view

| Method | Path | Returns |
|---|---|---|
| GET | `/api/sessions/:id/screenshot` | PNG image |
| GET | `/api/sessions/:id/live` | PNG image, fresh every request (`Cache-Control: no-store`) — poll this for live view |
| GET | `/api/sessions/:id/pdf` | A4 PDF |

## Replay

| Method | Path | Description |
|---|---|---|
| POST | `/api/sessions/:id/replay/start` | Start capturing frames (every 500 ms) |
| POST | `/api/sessions/:id/replay/stop` | Stop, stitch frames to MP4 with ffmpeg, returns `{frames, replay, bytes}` |
| GET | `/api/sessions/:id/replay` | Download the MP4 (404 `no_replay_yet` if none) |
| GET | `/api/sessions/:id/replay/frames` | List captured frame files |

## Downloads / uploads

| Method | Path | Description |
|---|---|---|
| POST | `/api/sessions/:id/download` | `{url}` — fetches the real file through the server's HTTP stack (same egress proxy) and saves it to `data/downloads/`, returns `{file, bytes, via}`. Does not carry the session's cookies. |
| GET | `/api/downloads/:file` | Download a saved file |
| POST | `/api/sessions/:id/upload` | `multipart/form-data` with `file` + `selector` — sets the file into a page file input (under its real filename) |
| POST | `/api/test-upload` | Test endpoint for the self-hosted form at `/test-upload.html` — accepts the form's file and echoes its name/size |

## Search / fetch (free, keyless)

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/search` | `{query}` | Server-side HTML fetch first: DuckDuckGo HTML, then Bing HTML (redirect links unwrapped to the real destination). Falls back to real browser navigation. Returns `{engine, count, results:[{title, url}]}`. 502 `search_no_results` when every engine comes back empty. |
| POST | `/api/fetch` | `{url}` | Real browser navigation, returns `{url, title, text}`. |

## Dashboard

`GET /` — the dashboard UI (static, `public/index.html`).

## Agent terminal

The terminal is session-scoped and drives the same **real Chromium** page as the browser API. It intentionally does not execute a host OS shell.

| Method | Path | Body / response |
|---|---|---|
| POST | `/api/sessions/:id/terminal` | `{ "command": "open https://example.org" }` → `{ok, output, url?, browserChanged?, screenshotUrl?}` |
| GET | `/api/sessions/:id/terminal/history` | `{ok:true, entries:[{command,output,createdAt,exitCode}]}` (last 80 commands) |
| DELETE | `/api/sessions/:id/terminal/history` | `{ok:true}` |

Commands: `help`, `status`, `open`/`browse`, `read`, `url`, `title`, `click`, `fill`, `press`, `scroll`, `screenshot`, `pwd`, `ls`, `cat`, `write`, `append`, `rm`. Workspace files are virtual and in-memory, limited to 32 KiB each. Session terminal history and workspace files disappear on server restart or session deletion.

`BROWSERBRO_TOKEN` (optional) requires `Authorization: Bearer <token>` for every `/api/*` endpoint, including `/api/health` and agent-terminal commands. Without a token, the API is unauthenticated and **must remain loopback-only or behind a trusted private gateway**. Use TLS and a strong bearer token for remote access; never expose unrestricted browser automation on the public internet.

`BROWSERBRO_HUB_URL` (optional, e.g. `https://monico-labs-hub.onrender.com`) accepts Monico buyer access codes as well: a caller with a valid code whose grant names product `browserbro` passes the gate as `X-Access-Code` (or `?code=`), alongside the operator token when both are set. The dashboard picks a `?code=` up once and sends it on every API call. Codes are verified against the hub's `/api/auth/code` (same endpoint Code Runner Pro uses) and cached 15 minutes; a real code without a BrowserBro grant gets 403, an unknown code 401, an unreachable hub 503. With neither `BROWSERBRO_TOKEN` nor `BROWSERBRO_HUB_URL` set, the API stays open as before.
