#!/usr/bin/env bash
# Verification script for issue #406
# Confirms the CLI agent can authenticate and view the Joi Ascend profile.
#
# Prerequisites:
#   - npm install (dependencies installed)
#   - Core package built: npx tsc -b packages/core
#   - Authenticated LinkedIn session (run: linkedin login --manual)
#
# Usage:
#   bash scripts/verify-agent-login-profile.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI_ENTRY="$ROOT_DIR/packages/cli/src/bin/linkedin.ts"
TARGET_PROFILE="joi-ascend"
REPORT_FILE="$ROOT_DIR/scripts/verify-agent-login-profile-report.json"

echo "=== LinkedIn Buddy Agent Verification ==="
echo "Target profile: $TARGET_PROFILE"
echo ""

# Step 1: Check auth status
echo "--- Step 1: Checking auth status ---"
STATUS_OUTPUT=$(npx tsx "$CLI_ENTRY" status 2>&1) || true
echo "$STATUS_OUTPUT" | head -20

AUTHENTICATED=$(echo "$STATUS_OUTPUT" | grep -o '"authenticated": [a-z]*' | head -1 | awk '{print $2}')

if [ "$AUTHENTICATED" != "true" ]; then
  echo ""
  echo "ERROR: Not authenticated."
  echo "Current URL: $(echo "$STATUS_OUTPUT" | grep -o '"currentUrl": "[^"]*"' | head -1)"
  echo "Reason: $(echo "$STATUS_OUTPUT" | grep -o '"reason": "[^"]*"' | head -1)"
  echo ""
  echo "To fix: Run one of:"
  echo '  npx tsx packages/cli/src/bin/linkedin.ts login --manual'
  echo '  npx tsx packages/cli/src/bin/linkedin.ts login --headless --warm-profile --headed-fallback'
  echo ""
  echo "If headless login triggers a checkpoint, manual browser login is required."

  # Save partial report
  cat > "$REPORT_FILE" <<EOF
{
  "verification": "issue-406",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "step1_auth_status": "FAILED",
  "authenticated": false,
  "status_output": $(echo "$STATUS_OUTPUT" | head -30),
  "step2_profile_view": "SKIPPED",
  "result": "AUTH_REQUIRED"
}
EOF

  echo "Report saved to: $REPORT_FILE"
  exit 1
fi

echo "Auth status: authenticated"
IDENTITY=$(echo "$STATUS_OUTPUT" | grep -o '"identity":' || echo "")
if [ -n "$IDENTITY" ]; then
  echo "Identity found in status output."
fi
echo ""

# Step 2: View Joi Ascend profile
echo "--- Step 2: Viewing Joi Ascend profile ---"
PROFILE_OUTPUT=$(npx tsx "$CLI_ENTRY" profile view "$TARGET_PROFILE" 2>&1) || true
echo "$PROFILE_OUTPUT" | head -40

FULL_NAME=$(echo "$PROFILE_OUTPUT" | grep -o '"full_name": "[^"]*"' | head -1 | sed 's/"full_name": "//;s/"//')
HEADLINE=$(echo "$PROFILE_OUTPUT" | grep -o '"headline": "[^"]*"' | head -1 | sed 's/"headline": "//;s/"//')
PROFILE_URL=$(echo "$PROFILE_OUTPUT" | grep -o '"profile_url": "[^"]*"' | head -1 | sed 's/"profile_url": "//;s/"//')

if [ -z "$FULL_NAME" ]; then
  echo ""
  echo "ERROR: Failed to extract profile data."
  echo "Output: $PROFILE_OUTPUT"
  exit 1
fi

echo ""
echo "=== Verification Results ==="
echo "Full Name:   $FULL_NAME"
echo "Headline:    $HEADLINE"
echo "Profile URL: $PROFILE_URL"
echo ""
echo "VERIFICATION PASSED: Agent can authenticate and view Joi Ascend profile."

# Save full report
cat > "$REPORT_FILE" <<EOF
{
  "verification": "issue-406",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "step1_auth_status": "PASSED",
  "authenticated": true,
  "step2_profile_view": "PASSED",
  "target_profile": "$TARGET_PROFILE",
  "full_name": "$FULL_NAME",
  "headline": "$HEADLINE",
  "profile_url": "$PROFILE_URL",
  "result": "VERIFIED"
}
EOF

echo "Report saved to: $REPORT_FILE"
