# Rollback

Rollback never deletes, recreates, moves, overwrites, or imports the Google Drive folder `1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo`. The ZIP download is an external copy only. Restoring an archive into the folder is not part of this application.

## Sequence

1. Remove or disable the Telegram webhook first if the current deployment is corrupting state or cannot commit.
2. Roll the Vercel deployment back to the previous build only when that build can read every event schema version already stored in the Google Drive folder.
3. If the previous build cannot read a newer event, keep the webhook disabled and roll forward with a compatible reader.
4. Leave the Google Drive folder in place. A replacement Sandbox may reuse the same name and hydrate its scratch directory from that folder. Do not point the deployment at a different folder id.
5. Confirm `/api/health`, a read-only dashboard page, and one download against the retained files before registering the webhook again.

## What not to do

- Do not import a ZIP back into `data/`.
- Do not delete `data/records`, projections, or log files as a recovery step.
- Do not point a test command at the folder unless `TELEGRAM_AGENT_LIVE_PREVIEW=authorized`.
- Do not open a public port on the Sandbox to inspect files. Use the private SDK and the authenticated download.
