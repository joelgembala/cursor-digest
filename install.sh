#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/autobrief"
REPORTS_DIR="$HOME/Documents/cursor-reports"
NODE_PATH="$(which node 2>/dev/null || true)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $1"; }
fail()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

echo "======================================"
echo "  AutoBrief — Installer"
echo "======================================"
echo ""

# --- 1. Check Node.js ---
if [ -z "$NODE_PATH" ]; then
  fail "Node.js not found. Install via: brew install node"
fi
info "Node.js found: $NODE_PATH ($(node --version))"

# --- 2. Check .env ---
ENV_FILE="$SCRIPT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  fail ".env not found. Copy .env.example to .env and fill in your credentials."
fi

# Source .env (only export lines with values)
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# Validate required Circuit credentials
if [ -z "${BRIDGE_API_CLIENT_ID:-}" ] || [ -z "${BRIDGE_API_CLIENT_SECRET:-}" ]; then
  fail "BRIDGE_API_CLIENT_ID and BRIDGE_API_CLIENT_SECRET must be set in .env"
fi
info "Circuit credentials loaded from .env"

# Validate Webex credentials
if [ -z "${WEBEX_CLIENT_ID:-}" ] || [ -z "${WEBEX_CLIENT_SECRET:-}" ]; then
  warn "WEBEX_CLIENT_ID / WEBEX_CLIENT_SECRET not set — Webex ingestion will be disabled"
fi

# Validate MS To Do credentials
if [ -z "${MS_TODO_CLIENT_ID:-}" ]; then
  warn "MS_TODO_CLIENT_ID not set — To Do task creation will be disabled"
fi

# --- 3. Check config.json ---
echo ""
if [ ! -f "$SCRIPT_DIR/config.json" ]; then
  fail "config.json not found. Copy config.example.json to config.json and fill in your values."
fi
info "config.json found"

# --- 4. Install dependencies ---
echo ""
cd "$SCRIPT_DIR"
npm ci --silent 2>/dev/null || npm install --silent 2>/dev/null
info "Dependencies installed"

# --- 5. Create output directories ---
echo ""
mkdir -p "$REPORTS_DIR/daily" "$REPORTS_DIR/weekly"
info "Report directories: $REPORTS_DIR"

mkdir -p "$LOG_DIR"
info "Log directory: $LOG_DIR"

# --- 6. Generate plist files ---
echo ""
mkdir -p "$SCRIPT_DIR/launchd"

generate_plist() {
  local LABEL="$1"
  local MODE="$2"
  local PLIST_PATH="$SCRIPT_DIR/launchd/${LABEL}.plist"
  local CALENDAR_INTERVAL="$3"

  cat > "$PLIST_PATH" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${NODE_PATH}</string>
		<string>${SCRIPT_DIR}/digest.mjs</string>
		<string>--mode=${MODE}</string>
	</array>
	<key>StartCalendarInterval</key>
	${CALENDAR_INTERVAL}
	<key>EnvironmentVariables</key>
	<dict>
		<key>BRIDGE_API_CLIENT_ID</key>
		<string>${BRIDGE_API_CLIENT_ID}</string>
		<key>BRIDGE_API_CLIENT_SECRET</key>
		<string>${BRIDGE_API_CLIENT_SECRET}</string>
		<key>BRIDGE_API_APP_KEY</key>
		<string>${BRIDGE_API_APP_KEY:-}</string>
		<key>MS_TODO_CLIENT_ID</key>
		<string>${MS_TODO_CLIENT_ID:-}</string>
		<key>MS_TODO_TENANT_ID</key>
		<string>${MS_TODO_TENANT_ID:-}</string>
		<key>MS_TODO_CLIENT_SECRET</key>
		<string>${MS_TODO_CLIENT_SECRET:-}</string>
		<key>WEBEX_CLIENT_ID</key>
		<string>${WEBEX_CLIENT_ID:-}</string>
		<key>WEBEX_CLIENT_SECRET</key>
		<string>${WEBEX_CLIENT_SECRET:-}</string>
		<key>JIRA_EMAIL</key>
		<string>${JIRA_EMAIL:-}</string>
		<key>JIRA_API_TOKEN</key>
		<string>${JIRA_API_TOKEN:-}</string>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
	<key>StandardOutPath</key>
	<string>${LOG_DIR}/${MODE}-stdout.log</string>
	<key>StandardErrorPath</key>
	<string>${LOG_DIR}/${MODE}-stderr.log</string>
	<key>WorkingDirectory</key>
	<string>${SCRIPT_DIR}</string>
</dict>
</plist>
PLIST_EOF

  info "Generated $PLIST_PATH"
}

# Daily: Mon-Fri at 5:00 PM
DAILY_CALENDAR='<array>
		<dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
		<dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
		<dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
		<dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
		<dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
	</array>'

# Weekly: Friday at 10:00 AM
WEEKLY_CALENDAR='<dict>
		<key>Weekday</key><integer>5</integer>
		<key>Hour</key><integer>10</integer>
		<key>Minute</key><integer>0</integer>
	</dict>'

generate_plist "com.autobrief.daily" "daily" "$DAILY_CALENDAR"
generate_plist "com.autobrief.weekly" "weekly" "$WEEKLY_CALENDAR"

# --- 7. Load LaunchAgents ---
echo ""
mkdir -p "$LAUNCH_AGENTS_DIR"

for PLIST_FILE in "$SCRIPT_DIR/launchd/"*.plist; do
  PLIST_NAME="$(basename "$PLIST_FILE")"
  TARGET="$LAUNCH_AGENTS_DIR/$PLIST_NAME"

  if [ -f "$TARGET" ]; then
    launchctl unload "$TARGET" 2>/dev/null || true
    rm -f "$TARGET"
  fi

  ln -s "$PLIST_FILE" "$TARGET"
  launchctl load "$TARGET"
  info "Loaded ${PLIST_NAME%.plist}"
done

# --- 8. Summary ---
echo ""
echo "======================================"
echo "  AutoBrief — Installation Complete"
echo "======================================"
echo ""
echo "Schedule:"
echo "  Daily brief:   Mon–Fri at 5:00 PM"
echo "  Weekly report: Friday at 10:00 AM"
echo ""
echo "Output:"
echo "  Daily:   $REPORTS_DIR/daily/"
echo "  Weekly:  $REPORTS_DIR/weekly/"
echo "  Logs:    $LOG_DIR/"
echo ""
echo "Next steps:"
echo "  1. Run 'node digest.mjs --setup-webex' to authorize Webex"
echo "  2. Run 'node digest.mjs --list-spaces' to find space IDs"
echo "  3. Add space IDs to config.json"
echo "  4. Run 'node digest.mjs --setup-todo' to authorize Microsoft To Do"
echo "  5. Test: node digest.mjs --mode=daily --dry-run"
echo ""
echo "Note: VPN is required for Circuit API calls (chat-ai.cisco.com)."
echo "      Keep your laptop open and plugged in for scheduled runs."
