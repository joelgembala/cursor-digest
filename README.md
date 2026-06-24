# AutoBrief

The status report you never write. AutoBrief automatically generates daily status reports and weekly updates from your Cursor IDE sessions and Webex conversations. Reports are written by AI in your voice — no manual input required. Action items are pushed to Microsoft To Do, and weekly priorities are converted into draft Jira stories.

All AI processing runs through Cisco's Circuit gateway (chat-ai.cisco.com). No data leaves Cisco's network.

## What it produces

**Daily report** (weekdays at 5:00 PM) — a structured summary grouped by project:

- What I Accomplished Today
- Action Items for Tomorrow
- Open Questions / Blockers

**Weekly report** (Fridays at 10:00 AM) — a narrative status update for Teamspace:

- What Moved Forward
- Where I Need Help
- Coming Up Next Week

## Sample output

**Daily report:**

```
## What I Accomplished Today

**Platform Migration**
- Coordinated with the backend team to finalize the API contract
  for the new search feature
- Reviewed the staging deployment with QA and confirmed the three
  priority bugs from last sprint are resolved

## Action Items for Tomorrow
- Follow up with DevOps on the production deployment timeline
- Send the data mapping spreadsheet to the vendor contact

## Open Questions / Blockers
- Waiting on security team's sign-off for the new API endpoint
```

**Weekly report excerpt:**

```
**Platform Migration** — I finalized the API contract with the backend
team after two rounds of review, which unblocked the frontend work.
QA confirmed the priority bugs are resolved in staging, and we're
now waiting on DevOps to schedule the production deployment window.
```

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│   Cursor IDE        │     │   Webex API          │
│   Agent Transcripts │     │   OAuth 2.0 + PKCE   │
│   (.jsonl files)    │     │                      │
└────────┬────────────┘     └────────┬─────────────┘
         │                           │
         │  Parse user queries       │  Fetch messages
         │  + assistant actions      │  Filter to owner's
         │                           │  conversations
         └───────────┬───────────────┘
                     │
              ┌──────▼──────┐
              │ Circuit API  │
              │ (chat-ai)    │
              │ Summarize    │
              └──────┬──────┘
                     │
         ┌───────────┼───────────────┐
         │           │               │
    ┌────▼────┐ ┌────▼─────┐  ┌─────▼──────┐
    │ Markdown │ │ MS To Do │  │ Jira Story │
    │ Report   │ │ Tasks    │  │ Proposals  │
    └─────────┘ └──────────┘  └────────────┘
```

## Prerequisites

- **Node.js 18+** — `brew install node`
- **macOS** — uses launchd for scheduling (adaptable to cron on Linux)
- **Cisco VPN** — required for Circuit API (chat-ai.cisco.com) and id.cisco.com
- **Circuit credentials** — `BRIDGE_API_CLIENT_ID`, `BRIDGE_API_CLIENT_SECRET`, `BRIDGE_API_APP_KEY`
- **Webex Integration** — register at [developer.webex.com](https://developer.webex.com/my-apps) with scopes: `spark:messages_read`, `spark:rooms_read`, `spark:kms`, `meeting:transcripts_read`, `meeting:participants_read`, `meeting:schedules_read`
- **Microsoft To Do** — Azure app registration for device code flow
- **Jira** (optional) — API token from [Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens)

## Quick start

### 1. Clone and install

```bash
git clone <repo-url>
cd autobrief
npm ci
```

### 2. Set up credentials

```bash
cp .env.example .env
# Edit .env with your Circuit, Webex, MS To Do, and Jira credentials
```

### 3. Configure your profile

```bash
cp config.example.json config.json
# Edit config.json with your name, email, projects, and Webex spaces
```

### 4. Authorize Webex

```bash
node digest.mjs --setup-webex
```

This opens a browser for OAuth authorization. Tokens are saved locally and auto-refresh.

### 5. Discover Webex spaces

```bash
node digest.mjs --list-spaces
```

Copy the space IDs you want tracked into `config.json` under `webex.spaces`.

### 6. Authorize Microsoft To Do

```bash
node digest.mjs --setup-todo
```

### 7. Test

```bash
node digest.mjs --mode=daily --dry-run    # Test without Circuit API
node digest.mjs --mode=daily              # Full run (requires VPN)
```

### 8. Schedule

```bash
chmod +x install.sh
./install.sh
```

This reads your `.env`, generates launchd plist files with your credentials, and loads them. Reports run automatically on schedule.

## CLI reference

| Command | Description |
|---------|------------|
| `--mode=daily` | Generate daily report |
| `--mode=weekly` | Generate weekly report + Jira stories |
| `--dry-run` | Skip Circuit API, use mock data |
| `--setup-webex` | Run Webex OAuth authorization flow |
| `--setup-todo` | Run Microsoft To Do OAuth flow |
| `--list-spaces` | List Webex spaces with IDs |

## Output locations

| Output | Path |
|--------|------|
| Daily reports | `~/Documents/cursor-reports/daily/YYYY-MM-DD.md` |
| Weekly reports | `~/Documents/cursor-reports/weekly/YYYY-WNN.md` |
| Jira story proposals | `~/Documents/cursor-reports/weekly/stories-YYYY-WNN.json` |
| Logs | `~/Library/Logs/autobrief/` |

## Tech stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js (ES Modules) |
| AI | Cisco Circuit (chat-ai.cisco.com) |
| Webex | Webex REST API (OAuth 2.0 + PKCE) |
| Task Management | Microsoft Graph API (To Do) |
| Issue Tracking | Jira REST API |
| Scheduling | macOS launchd (LaunchAgents) |
| Storage | Local markdown files + JSON |

## Important notes

- **VPN required** — Circuit API calls go through chat-ai.cisco.com and id.cisco.com, both behind Cisco's network. Connect to VPN before running.
- **Laptop must stay awake** — Closing the lid drops VPN and suspends launchd. Keep the lid open and plugged in for scheduled runs.
- **Webex filtering** — For group spaces, only conversations you participated in are included (direct messages, thread context, and a 5-minute proximity window around your messages).
- **Token auto-refresh** — Webex tokens refresh automatically on each run. As long as the tool runs at least once within 90 days, tokens stay alive indefinitely.

## Questions?

Open an issue or reach out to Joel Gembala on Webex.
