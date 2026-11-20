#!/bin/bash
# renew-and-push.sh — keep Agents-city wired to browserbro permanently.
#
# The Pinggy free tunnel expires after 60 min and its URL changes on every
# restart. This script:
#   1. restarts the whole browserbro stack (proxy relay + browserbro + fresh tunnel)
#      via start.sh, which saves the new public URL to PUBLIC_URL.txt
#   2. if the URL changed, updates DEFAULT_BROWSERBRO_URL in
#      functions/api/browser/load.ts + status.ts in jaykk99/Agents-city
#      and pushes (Cloudflare Pages auto-deploys on push to main)
#   3. verifies the live city status endpoint says connected:true
#
# Run every ~40 min from a cron so the city never sits on a dead tunnel.
# No secrets in this script; it uses the gh CLI (Jay's GitHub auth).

set -u
BB_DIR="$HOME/workspace/browserbro"
CITY_DIR="$HOME/workspace/city-work"
LOG="$HOME/workspace/browserbro/renew.log"

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

bash "$BB_DIR/start.sh" > /tmp/renew-start.log 2>&1
NEW_URL="$(cat "$BB_DIR/PUBLIC_URL.txt" 2>/dev/null | tr -d '[:space:]')"
if [ -z "$NEW_URL" ]; then log "FAIL: no public URL after start.sh"; exit 1; fi

OLD_URL="$(grep -oE "https://[a-z0-9.-]+\.run\.pinggy[^'\"]*" "$CITY_DIR/load.ts" 2>/dev/null | head -1)"
if [ "$NEW_URL" = "$OLD_URL" ]; then
  log "URL unchanged ($NEW_URL), verifying live status"
else
  log "URL changed $OLD_URL -> $NEW_URL, updating city functions"
  sed -i "s|https://[a-z0-9.-]*\.run\.pinggy[^'\"]*|$NEW_URL|g" "$CITY_DIR/load.ts" "$CITY_DIR/status.ts"
  python3 - "$CITY_DIR" <<'PYEOF' >> "$LOG" 2>&1 || { log "FAIL: push failed"; exit 1; }
import base64, json, subprocess, sys
CITY = sys.argv[1]
def gh(*args, input_data=None):
    r = subprocess.run(["gh","api"]+list(args), input=input_data, capture_output=True, text=True, timeout=120)
    if r.returncode != 0: raise RuntimeError(r.stderr[:400])
    return json.loads(r.stdout) if r.stdout.strip() else {}
def put(path, local, msg):
    content = base64.b64encode(open(local,"rb").read()).decode()
    cur = gh(f"repos/jaykk99/Agents-city/contents/{path}")
    body = {"message":msg,"content":content,"branch":"main","sha":cur["sha"]}
    out = gh(f"repos/jaykk99/Agents-city/contents/{path}","--method","PUT","--input","-", input_data=json.dumps(body))
    print(path, "->", out["commit"]["sha"][:7])
put("functions/api/browser/load.ts", CITY+"/load.ts", "browserbro tunnel URL renewed")
put("functions/api/browser/status.ts", CITY+"/status.ts", "browserbro tunnel URL renewed")
PYEOF
  log "pushed new URL to Agents-city main"
fi

sleep 20
STATUS="$(curl -s --max-time 20 https://agents-city.pages.dev/api/browser/status)"
echo "$STATUS" | grep -q '"connected":true' && log "LIVE OK $NEW_URL" || log "WARN status not connected yet: $STATUS"
