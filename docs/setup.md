# Connected setup

Start with the isolated [offline demonstration](../README.md#try-it-without-accounts-or-credentials). The connected workflow requires your own authorized service access and configuration. No credentials or real work transcripts are included.

## Manual configuration

1. Install Node.js 20+ and run `npm ci`.
2. Copy `config.example.json` to `config.json`. Set the transcript directories, project names, output path, and persona. Leave `webex.spaces` empty if you do not intend to ingest messages. Remove `jira` if you do not want local story drafts.
3. Copy `.env.example` to `.env` and supply credentials for the integrations you intend to use. Both local files are ignored by Git.
4. Export those variables before invoking the CLI; it does not automatically load `.env`:

```sh
set -a
. ./.env
set +a
```

Only source a `.env` file you control: this is shell syntax, not an inert data parser.

## Service access

- **Circuit:** requires authorized credentials for the configured enterprise gateway and any network/VPN access it requires. The repository does not provide these credentials or a public replacement service.
- **Webex (optional):** register an integration with appropriate message/room scopes, then run `node digest.mjs --setup-webex`. Use `node digest.mjs --list-spaces` and select only spaces you are authorized to process. Tokens are stored locally in an ignored file. Expired or revoked authorization may require setup again.
- **Microsoft To Do:** configure a Microsoft application for the device-code flow used by the adapter, then run `node digest.mjs --setup-todo`. Normal daily operation attempts task creation. Without working authorization, failures can be queued locally.
- **Jira drafts (optional):** the weekly CLI writes local story proposals. It does not publish those issues. Review and publish separately with an authorized tool.

Do not assume content stays inside one network: selected inputs are sent to the configured AI gateway, and generated tasks go to Microsoft Graph. Review the provider arrangements and the content selected before connecting actual work data.

## Run manually

```sh
node digest.mjs --mode=daily --dry-run
node digest.mjs --mode=daily
node digest.mjs --mode=weekly
```

`--dry-run` skips AI summarization and task writes, but still reads configured Webex spaces and writes local reports. The isolated `npm run demo` is the route that uses no connected accounts.

Reports go under the configured output directory in `daily/` and `weekly/`. Pending tasks and story drafts may also be stored there; treat generated output as private when it contains real work.

## Optional macOS scheduling

Inspect `install.sh` before running it. `bash install.sh` writes and loads launchd jobs for weekday daily briefs at 17:00 and Friday weekly reports at 10:00 in the machine's local time. It does not configure service authorization for you.

The installer embeds credentials in generated, Git-ignored `launchd/*.plist` files. Those files and their logs must remain private. The machine must be available for scheduled execution. This portfolio update did not install or test a live schedule.

To remove the installed schedules, unload their entries under `~/Library/LaunchAgents` and remove the corresponding AutoBrief links. Preserve reports you want to retain. Service authorization can be revoked through each provider.

## Verification scope

`npm test` checks the real parser and isolated CLI, including malformed/stale input and the no-input case. It does not exercise live OAuth, scheduling, model accuracy, task deduplication, or provider availability.
