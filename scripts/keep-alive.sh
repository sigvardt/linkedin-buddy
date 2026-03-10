#!/bin/bash
# LinkedIn Buddy CLI session keep-alive
# Checks health; if session expired, re-transplants cookies from OpenClaw browser (CDP 18800)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUDDY_HOME="${LINKEDIN_BUDDY_HOME:-$HOME/.linkedin-buddy/linkedin-buddy}"
LOG_FILE="$BUDDY_HOME/keep-alive.log"
COOKIES_TMP="/tmp/linkedin-cookies-refresh.json"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

mkdir -p "$(dirname "$LOG_FILE")"

# Check health via CLI
HEALTH=$(linkedin health 2>&1) || true
AUTHENTICATED=$(echo "$HEALTH" | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin)['session']['authenticated'])" 2>/dev/null || echo "false")

if [ "$AUTHENTICATED" = "True" ] || [ "$AUTHENTICATED" = "true" ]; then
  log "OK — session authenticated"
  exit 0
fi

log "WARN — session expired, attempting cookie transplant from OpenClaw browser"

# Check if OpenClaw browser is available on CDP 18800
if ! curl -s http://127.0.0.1:18800/json/version > /dev/null 2>&1; then
  log "ERROR — OpenClaw browser not available on CDP 18800, cannot re-auth"
  exit 1
fi

# Extract cookies from OpenClaw browser and inject into persistent profile
cd "$REPO_DIR"
node -e "
const { chromium } = require('playwright-core');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:18800');
  const ctx = browser.contexts()[0];
  const cookies = await ctx.cookies('https://www.linkedin.com');
  fs.writeFileSync('$COOKIES_TMP', JSON.stringify(cookies));
  await browser.close();
})();
" 2>> "$LOG_FILE"

if [ ! -s "$COOKIES_TMP" ]; then
  log "ERROR — failed to extract cookies"
  exit 1
fi

node -e "
const { chromium } = require('playwright-core');
const fs = require('fs');
(async () => {
  const cookies = JSON.parse(fs.readFileSync('$COOKIES_TMP', 'utf8'));
  const profileDir = '$BUDDY_HOME/profiles/default';
  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  await context.addCookies(cookies);
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await context.close();
  console.log('OK');
})();
" 2>> "$LOG_FILE"

rm -f "$COOKIES_TMP"

# Verify
VERIFY=$(linkedin status 2>&1) || true
REAUTH=$(echo "$VERIFY" | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin)['authenticated'])" 2>/dev/null || echo "false")

if [ "$REAUTH" = "True" ] || [ "$REAUTH" = "true" ]; then
  log "OK — re-authenticated via cookie transplant"
else
  log "ERROR — re-auth failed, manual intervention needed"
  exit 1
fi
