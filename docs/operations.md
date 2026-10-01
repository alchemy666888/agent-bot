# Operations

## Routine checks

`GET /api/health` must safely report configuration and schema compatibility without returning credentials. Monitor PostgreSQL availability/locks/storage, lifecycle transition errors, authorization denials, tool latency/outcomes, expired execution leases, unknown outcomes, Telegram delivery, and append-only audit ingestion. Correlate a run by `correlation_id`; logs contain reason codes and hashes, not raw secrets or unsanitized tool payloads.

Useful operator questions include: skills/runs by owner and state; current/version pointer consistency; grants whose capability is disabled; expired processing leases; unknown-outcome tool calls; and audit events by actor, target, capability, execution, and UTC interval. Access these through read-only views/tooling, not ad-hoc mutation.

## Capability and incident controls

Set `SKILLS_ENABLED=false` to stop new skill runs. Disable a registry capability to stop its new dispatches; authorization checks the kill switch again immediately before a side effect. Do not edit a grant or approved version to contain an incident—revoke/disable it and create a new explicitly approved revision.

## Skill authoring pull requests

`/skill_approve <revision>` approves the exact commit and digest recorded for that
revision. Before creating a pull request, the worker re-reads the branch ref,
compares it with the draft base, restricts the diff to `manifest.json` and
`SKILL.md` under that skill's directory, validates both documents and their byte
limits, and checks the Telegram author and requested capability IDs against
operator-controlled sets. The validated manifest's `authoring` object is the
authorization record (skill ID, draft ID, revision, digest, owner, and requested
capabilities); a pull request title or body must never be parsed for authorization.

Pull requests target `GITHUB_SKILLS_BRANCH`. Finding a pull request with the same
base, branch, and exact head SHA is an idempotent success, including when it has
already merged. A moved/diverged branch or GitHub conflict requires a new
revision; the worker never force-pushes or overwrites it. Successful PR creation
is reported as installed-but-awaiting-operator-merge, while an already merged PR
is reported as installed-on-base.

The bot deliberately does not merge pull requests. An operator must merge after
required branch-protection reviews and checks pass. The current authoring flow
needs GitHub repository **Contents: write** and **Pull requests: write**. If
automated merge is added, it must query and require those protection/check
results and the GitHub App will additionally need **Checks: read** and
**Administration: read**; do not grant those extra permissions to the current
create-only workflow.

For a stuck run, inspect its execution, idempotency key, last committed step, descriptor retry class, provider idempotency/reference, and audit trail. Reclaim an expired lease only through the reconciliation command. Retry a call only when it is declared retry-safe or the provider can return the original result for the same key. Mark an ambiguous non-retry-safe call `unknown_outcome`, investigate externally, and tell the user; never replay it automatically.

Database/Sandbox failures use sanitized stages (`bootstrap`, `persistence-sync`, `operation`, `tool-dispatch`, `delivery`). PostgreSQL authentication (`28P01`), DNS (`ENOTFOUND`), and IPv4 routing (`ENETUNREACH`) are infrastructure failures. Fix connectivity and let checkpoint recovery resume; do not switch to local files.

## Backup and restoration

Schedule encrypted provider snapshots plus logical backups at an operator-defined recovery interval. Backups must consistently include schema migrations, users/conversations/messages/updates/logs, operational skill references, registry/grants, selections, executions/tool calls, idempotency, and audit events. Skill definitions and their version history are recovered from the separately verified GitHub mirror/bundle, not from PostgreSQL. Store backup ID, database/schema version, checksum, UTC time, and retention. Never include application/provider credentials.

At least once per release and on the regular disaster-recovery cadence:

1. Restore the chosen backup to a new isolated database with no Telegram webhook and stubbed external adapters.
2. Run `DATABASE_URL=<isolated-url> pnpm restore:verify`.
3. Verify migration checksums, FK/integrity checks, row counts for remaining application tables, exact grants, operational references, selections, audit continuity, and absence of secrets.
4. Reconcile every restored skill reference to a reachable GitHub commit, then list/discover as two test owners, prove cross-owner denial, and dry-run a restored selected skill pinned to its commit.
5. Record duration, recovery point, output, and operator approval in `docs/acceptance-evidence.md`; destroy the isolated restore according to policy.

An export is useful for inspection but is not a database backup unless restoration from it has passed the same checks.

## Acceptance gate

Run `pnpm test -- tests/acceptance/skills` after migrations, registry changes, authorization changes, and recovery changes. The feature remains incomplete if any requirement lacks an existing implementation module, named automated acceptance test, passing CI evidence, Preview walkthrough, and restore rehearsal.
