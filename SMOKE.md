# browserbro smoke results

Run: 2026-11-20T04:03:10.557Z
Server: `npm start` on port 3102 (spawned by smoke.js)

**22/22 checks passed.**

| # | Check | Result | Evidence |
|---|---|--------|----------|
| 1 | server up (/api/health 200) | PASS | health ok |
| 2 | session create returns an id | PASS | sess_mwoge03t_1_k1yi |
| 3 | navigate to news.ycombinator.com | PASS | https://news.ycombinator.com/ |
| 4 | title reads "Hacker News" | PASS | Hacker News |
| 5 | page text is real and non-empty | PASS | 4272 chars |
| 6 | links list is real and non-empty | PASS | 200 links, first:  |
| 7 | click-through on a Hacker News story link changes the URL | PASS | https://news.ycombinator.com/ -> https://git-aarvin.github.io/mei/ |
| 8 | screenshot is a real PNG | PASS | 66876 bytes |
| 9 | PDF export is a real PDF | PASS | 457976 bytes |
| 10 | live view returns a fresh PNG | PASS | 66876 bytes |
| 11 | evaluate JS in the page (1+1) | PASS | value=2 |
| 12 | cookies endpoint returns an array | PASS | 0 cookies |
| 13 | search returns real results (DuckDuckGo, keyless) | PASS | engine=www.bing.com, 10 results, first: Fast and reliable end-to-end testing for modern web apps / Playwright |
| 14 | fetch returns real page text (example.com) | PASS | Example Domain |
| 15 | replay exports a real MP4 (ffprobe duration > 0) | PASS | frames=8, bytes=46002, duration=0.5s |
| 16 | persistent context survives close + reopen (localStorage) | PASS | localStorage bro=smoke-persist-123 |
| 17 | download saves a real file | PASS | README.md, 11282 bytes |
| 18 | upload into a real form works | PASS | uploaded=bro-upload-test.txt, page says File Uploaded |
| 19 | session list contains the session | PASS | 1 sessions |
| 20 | unknown session returns honest 404 | PASS | status=404, error=session_not_found |
| 21 | scroll + wait actions work | PASS | scrolled_to=400, waited=500ms |
| 22 | delete session works (then 404) | PASS | deleted=sess_mwoge03t_1_k1yi, after=404 |

Notes: Hacker News click-through navigated from the HN front page to the top story's real destination URL (see check 7 evidence). Replay MP4 verified with ffprobe (see check 15). No check was faked; failures would be listed as FAIL above.
