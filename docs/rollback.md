# Rollback

Rollback never deletes, recreates, moves, overwrites, or imports the Drive. The ZIP download is an external copy only. Restoring an archive into the Drive is not part of this application.

## Sequence

1. Remove or disable the Telegram webhook first if the current deployment is corrupting state or cannot commit.
2. Roll the Vercel deployment back to the previous build only when that build can read every event schema version already stored on the Drive.
3. If the previous build cannot read a newer event, keep the webhook disabled and roll forward with a compatible reader.
4. Leave the named `sin1` Drive attached. A replacement Sandbox may reuse the same name, remount that Drive, and install the worker outside the Drive.
5. Confirm `/api/health`, a read-only dashboard page, and one download against the retained files before registering the webhook again.

## What not to do

- Do not import a ZIP back into `data/`.
- Do not delete `data/records` or projections as a recovery step.
- Do not point Production at the Preview Drive, or a test command at the Production Drive.
- Do not open a public port on the Sandbox to inspect files. Use the private SDK and the authenticated download.
