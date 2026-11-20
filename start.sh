#!/bin/bash
# start.sh — (re)start the whole browserbro stack for Agents-city.
#
#   1. proxy-relay.js on 127.0.0.1:3129 (see proxy-relay.js for why:
#      the sandbox egress proxy 403s Chromium's direct CONNECTs)
#   2. browserbro on localhost:3101 with BROWSERBRO_PROXY pointing at it
#   3. Pinggy free SSH tunnel (no account, no card) exposing :3101 publicly
#
# The Pinggy URL is random and EXPIRES AFTER 60 MINUTES. After a restart,
# grab the new URL from /tmp/pinggy.log (also saved to PUBLIC_URL.txt),
# then update BROWSERBRO_URL (Pages secret) or DEFAULT_BROWSERBRO_URL in
# functions/api/browser/load.ts + status.ts in jaykk99/Agents-city and push.
#
# Usage: bash ~/workspace/browserbro/start.sh
# Check:  curl http://localhost:3101/api/health
#         curl $(cat ~/workspace/browserbro/PUBLIC_URL.txt)/api/health

set -u
BB_DIR="$HOME/workspace/browserbro"
LOG_DIR=/tmp

# 1. Relay (skip if already listening; /dev/tcp opens a bare TCP
# connection, no HTTP bytes, so the forwarder stays silent)
if ! (exec 3<>/dev/tcp/127.0.0.1/3129) 2>/dev/null; then
  (cd "$BB_DIR" && setsid node proxy-relay.js < /dev/null > $LOG_DIR/proxy-relay.log 2>&1 &)
  sleep 1
fi

# 2. browserbro (skip if already healthy)
if ! curl -s --max-time 5 http://localhost:3101/api/health | grep -q '"ok":true'; then
  pkill -f "node server.js" 2>/dev/null
  sleep 1
  (cd "$BB_DIR" && setsid env NODE_USE_ENV_PROXY=1 BROWSERBRO_PROXY=http://127.0.0.1:3129 node server.js < /dev/null > $LOG_DIR/browserbro.log 2>&1 &)
  sleep 4
fi

# 3. Pinggy tunnel (always fresh: the old URL is dead after 60 min anyway)
pkill -f "free@a.pinggy.io" 2>/dev/null
sleep 1
(setsid ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ProxyCommand="nc -X connect -x hatch-egress-proxy:3128 %h %p" \
  -o ServerAliveInterval=30 -p 443 -R0:localhost:3101 free@a.pinggy.io \
  < /dev/null > $LOG_DIR/pinggy.log 2>&1 &)
sleep 12
for i in 1 2 3 4 5 6; do
  grep -oE 'https://[a-z0-9.-]+\.run\.pinggy-free\.link' $LOG_DIR/pinggy.log | tail -1 > "$BB_DIR/PUBLIC_URL.txt" || true
  [ -s "$BB_DIR/PUBLIC_URL.txt" ] && break
  sleep 5
done

echo "--- browserbro:"; curl -s --max-time 10 http://localhost:3101/api/health || echo DOWN
echo "--- public URL:"; cat "$BB_DIR/PUBLIC_URL.txt" 2>/dev/null || echo "(none yet, see /tmp/pinggy.log)"
echo "--- public check:"; URL=$(cat "$BB_DIR/PUBLIC_URL.txt" 2>/dev/null); [ -n "$URL" ] && curl -s --max-time 20 "$URL/api/health" || echo "(skip)"
