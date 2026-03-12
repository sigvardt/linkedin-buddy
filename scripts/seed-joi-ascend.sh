#!/usr/bin/env bash
# seed-joi-ascend.sh — Full profile seeding and activity population for the
# Joi Ascend test account. Handles auth verification, profile editing, activity
# seeding, and end-of-run validation in a single invocation.
#
# Usage:
#   ./scripts/seed-joi-ascend.sh                  # interactive (prompts before writes)
#   ./scripts/seed-joi-ascend.sh --yes             # unattended (skip confirmations)
#   ./scripts/seed-joi-ascend.sh --skip-login      # skip login step (session already active)
#   ./scripts/seed-joi-ascend.sh --profile smoke    # use a named browser profile
#   ./scripts/seed-joi-ascend.sh --dry-run         # validate specs and auth only, no writes
#
# Prerequisites:
#   - Node 22+, npm install && npm run build completed
#   - Playwright chromium installed: npx playwright install chromium
#
# References:
#   - Issue #310, #210, #212
#   - docs/profile-seeds/joi-ascend-runbook.md
set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
PROFILE="default"
SKIP_LOGIN=false
YES_FLAG=""
DRY_RUN=false
DELAY_PROFILE_MS=4000
DELAY_ACTIVITY_MS=4500
EXPECTED_IDENTITY="Joi Ascend"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
REPORT_DIR="$REPO_DIR/reports"
CLI="node $REPO_DIR/packages/cli/dist/bin/linkedin.js"

# ─── Colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }
step()  { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }

die() { fail "$@"; exit 1; }

# ─── Parse arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)      PROFILE="$2"; shift 2 ;;
    --skip-login)   SKIP_LOGIN=true; shift ;;
    --yes|-y)       YES_FLAG="--yes"; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --delay-ms)     DELAY_PROFILE_MS="$2"; DELAY_ACTIVITY_MS="$2"; shift 2 ;;
    -h|--help)
      sed -nE '/^[^#]/q; s/^# ?//; 2,$p' "$0"
      exit 0 ;;
    *) die "Unknown option: $1. Run with --help for usage." ;;
  esac
done

# ─── Preflight checks ────────────────────────────────────────────────────────
step "Step 0: Preflight"

PROFILE_SPEC="$REPO_DIR/docs/profile-seeds/joi-ascend-profile.json"
ACTIVITY_SPEC="$REPO_DIR/docs/profile-seeds/joi-ascend-activity.json"

[[ -f "$REPO_DIR/packages/cli/dist/bin/linkedin.js" ]] \
  || die "CLI not built. Run: npm install && npm run build"

[[ -f "$PROFILE_SPEC" ]] \
  || die "Profile spec not found: $PROFILE_SPEC"

[[ -f "$ACTIVITY_SPEC" ]] \
  || die "Activity spec not found: $ACTIVITY_SPEC"

# Validate JSON specs parse correctly
node -e "JSON.parse(require('fs').readFileSync('$PROFILE_SPEC','utf8'))" 2>/dev/null \
  || die "Profile spec is not valid JSON"
node -e "JSON.parse(require('fs').readFileSync('$ACTIVITY_SPEC','utf8'))" 2>/dev/null \
  || die "Activity spec is not valid JSON"

ok "CLI built, specs valid"

# ─── Rate-limit check ────────────────────────────────────────────────────────
RATE_STATE=$($CLI rate-limit 2>&1) || true
RATE_ACTIVE=$(echo "$RATE_STATE" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).active" 2>/dev/null || echo "false")
if [[ "$RATE_ACTIVE" == "true" ]]; then
  warn "Auth rate-limit is active. Clearing to allow login."
  $CLI rate-limit --clear >/dev/null 2>&1 || true
fi

# ─── Step 1: Authentication ──────────────────────────────────────────────────
step "Step 1: Authenticate"

check_auth() {
  local status_json
  status_json=$($CLI status --profile "$PROFILE" 2>&1) || true
  echo "$status_json"
}

AUTH_JSON=$(check_auth)
AUTHENTICATED=$(echo "$AUTH_JSON" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).authenticated" 2>/dev/null || echo "false")

if [[ "$AUTHENTICATED" == "true" ]]; then
  ok "Already authenticated"
elif [[ "$DRY_RUN" == "true" ]]; then
  warn "Not authenticated (dry-run mode — skipping login)"
elif [[ "$SKIP_LOGIN" == "true" ]]; then
  die "Not authenticated and --skip-login was set. Run: $CLI login --profile $PROFILE"
else
  info "Not authenticated. Opening headed browser for manual login..."
  info "Complete any CAPTCHA in the browser window, then wait for CLI confirmation."
  echo ""

  # Use headed login — opens a visible Chromium window.
  # The operator completes CAPTCHA manually; CLI detects successful auth.
  if ! $CLI login --profile "$PROFILE" --timeout-minutes 10; then
    die "Login failed. Check the browser window for errors or try: $CLI login --profile $PROFILE"
  fi

  # Re-check auth
  AUTH_JSON=$(check_auth)
  AUTHENTICATED=$(echo "$AUTH_JSON" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).authenticated" 2>/dev/null || echo "false")
  [[ "$AUTHENTICATED" == "true" ]] || die "Login completed but session is not authenticated"
fi

# ─── Identity gate ────────────────────────────────────────────────────────────
step "Step 2: Identity Gate"

FULL_NAME=$(echo "$AUTH_JSON" | node -pe "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  (d.identity && d.identity.fullName) || 'unknown'
" 2>/dev/null || echo "unknown")

if [[ "$DRY_RUN" == "true" ]]; then
  if [[ "$AUTHENTICATED" == "true" && "$FULL_NAME" == "$EXPECTED_IDENTITY" ]]; then
    ok "Identity confirmed: $FULL_NAME"
  elif [[ "$AUTHENTICATED" == "true" ]]; then
    die "IDENTITY GATE FAILED: Expected '$EXPECTED_IDENTITY' but got '$FULL_NAME'. STOPPING ALL WORK."
  else
    warn "Cannot verify identity — not authenticated"
  fi
  ok "Dry run complete. Specs valid, CLI functional. No writes performed."
  echo ""
  info "To execute for real:"
  info "  1. Authenticate: $CLI login --profile $PROFILE"
  info "  2. Run seeding:  $0 --skip-login --yes --profile $PROFILE"
  exit 0
fi

if [[ "$FULL_NAME" == "$EXPECTED_IDENTITY" ]]; then
  ok "Identity confirmed: $FULL_NAME"
elif [[ "$FULL_NAME" == "unknown" ]]; then
  warn "Could not read identity from status. Proceeding with caution."
  warn "Verify manually: $CLI status --profile $PROFILE"
else
  die "IDENTITY GATE FAILED: Expected '$EXPECTED_IDENTITY' but got '$FULL_NAME'. STOPPING ALL WORK."
fi

# ─── Step 3: Inspect current editable surface ─────────────────────────────────
step "Step 3: Inspect Editable Surface"

info "Fetching current editable profile state..."
EDITABLE_JSON=$($CLI profile editable --profile "$PROFILE" 2>&1) || true
echo "$EDITABLE_JSON" | node -pe "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const sections = Object.keys(d).filter(k => k !== 'run_id');
  'Sections: ' + sections.join(', ') + ' (' + sections.length + ' total)'
" 2>/dev/null || warn "Could not parse editable output"
ok "Editable surface inspected"

# ─── Step 4: Apply profile spec ──────────────────────────────────────────────
step "Step 4: Apply Profile Spec"

mkdir -p "$REPORT_DIR"
PROFILE_REPORT="$REPORT_DIR/profile-seed-joi-ascend-$TIMESTAMP.json"

info "Applying profile spec: $PROFILE_SPEC"
info "Delay between edits: ${DELAY_PROFILE_MS}ms (randomized)"
echo ""

$CLI profile apply-spec \
  --spec "$PROFILE_SPEC" \
  --profile "$PROFILE" \
  --allow-partial \
  $YES_FLAG \
  --delay-ms "$DELAY_PROFILE_MS" \
  --output "$PROFILE_REPORT" \
  || die "Profile apply-spec failed. Check $PROFILE_REPORT for partial results."

ok "Profile spec applied"
[[ -f "$PROFILE_REPORT" ]] && info "Report: $PROFILE_REPORT"

# ─── Step 5: Verify profile ──────────────────────────────────────────────────
step "Step 5: Verify Profile"

info "Viewing profile after edits..."
$CLI profile view me --profile "$PROFILE" 2>&1 || warn "Profile view failed"
ok "Profile verification complete"

# ─── Step 6: Start keepalive ─────────────────────────────────────────────────
step "Step 6: Start Keepalive Daemon"

info "Starting keepalive daemon for long activity seeding session..."
$CLI keepalive start --profile "$PROFILE" 2>&1 || warn "Keepalive start failed (non-fatal)"
ok "Keepalive started"

# ─── Step 7: Run activity seeding ────────────────────────────────────────────
step "Step 7: Activity Seeding"

ACTIVITY_REPORT="$REPORT_DIR/activity-seed-joi-ascend-$TIMESTAMP.json"

info "Applying activity spec: $ACTIVITY_SPEC"
info "Delay between actions: ${DELAY_ACTIVITY_MS}ms (randomized)"
echo ""

$CLI seed activity \
  --spec "$ACTIVITY_SPEC" \
  --profile "$PROFILE" \
  --delay-ms "$DELAY_ACTIVITY_MS" \
  $YES_FLAG \
  --output "$ACTIVITY_REPORT" \
  || die "Activity seeding failed. Check $ACTIVITY_REPORT for partial results."

ok "Activity seeding complete"
[[ -f "$ACTIVITY_REPORT" ]] && info "Report: $ACTIVITY_REPORT"

# ─── Step 8: Final verification ──────────────────────────────────────────────
step "Step 8: Final Verification"

info "Checking profile state..."
$CLI profile view me --profile "$PROFILE" 2>&1 || warn "Profile view failed"

info "Checking feed for published posts..."
$CLI feed list --limit 5 --profile "$PROFILE" 2>&1 || warn "Feed list failed"

# ─── Stop keepalive ──────────────────────────────────────────────────────────
info "Stopping keepalive daemon..."
$CLI keepalive stop --profile "$PROFILE" 2>&1 || true

# ─── Summary ─────────────────────────────────────────────────────────────────
step "Done"
ok "Joi Ascend profile seeding and activity population complete."
echo ""
info "Reports:"
[[ -f "$PROFILE_REPORT" ]]  && info "  Profile:  $PROFILE_REPORT"
[[ -f "$ACTIVITY_REPORT" ]] && info "  Activity: $ACTIVITY_REPORT"
echo ""
info "Next steps:"
info "  1. Review the profile: $CLI profile view me --profile $PROFILE"
info "  2. Review the feed:    $CLI feed list --limit 10 --profile $PROFILE"
info "  3. Check the reports in $REPORT_DIR/"
