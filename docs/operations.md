# Operations

## Routine checks

`GET /api/health` must safely report configuration and schema compatibility without returning credentials. Monitor PostgreSQL availability/locks/storage, lifecycle transition errors, authorization denials, tool latency/outcomes, expired execution leases, unknown outcomes, Telegram delivery, and append-only audit ingestion. Correlate a run by `correlation_id`; logs contain reason codes and hashes, not raw secrets or unsanitized tool payloads.

Useful operator questions include: skills/runs by owner and state; current/version pointer consistency; grants whose capability is disabled; expired processing leases; unknown-outcome tool calls; and audit events by actor, target, capability, execution, and UTC interval. Access these through read-only views/tooling, not ad-hoc mutation.

## Router telemetry and acceptance thresholds

The model-runs dashboard labels `runKind=router` classification cost separately
from `runKind=answer` final-answer cost. Router records contain only outcome,
selected skill/tool identifiers, confidence, latency, token counts, estimated
cost, provider request ID, schema-validation result, routing mode, reroute
count, fallback reason, and shadow disagreement. They must not contain the
routing prompt, catalog descriptions, rationale, credentials, or raw tool
arguments.

Evaluate rolling 15-minute windows and the corresponding 24-hour baseline.
Pause promotion—or roll enforced mode back to shadow—if any threshold is met:

| Signal                       | Threshold                                                 |
| ---------------------------- | --------------------------------------------------------- |
| Router failure rate          | > 1% of routing attempts                                  |
| p95 added router latency     | > 1,000 ms or > 20% above the accepted shadow baseline    |
| Schema-invalid response rate | > 0.5%                                                    |
| Forced-search rate           | > 10% or > 2x the accepted shadow baseline                |
| Unexpected token cost        | Router plus answer cost > 10% above the per-turn baseline |

Also require zero unauthorized selections/executions and zero protocol leaks.
Treat missing usage or request IDs as unavailable telemetry, not zero cost.
Investigate disagreement and fallback reason distributions without persisting
the private catalog or model rationale.

## Capability and incident controls

Set `SKILLS_ENABLED=false` to stop new skill runs. Disable a registry capability to stop its new dispatches; authorization checks the kill switch again immediately before a side effect. Do not edit a grant or approved version to contain an incident—revoke/disable it and create a new explicitly approved revision.

## GitHub connector, rate limits, and cache

Monitor safe event counts and latency for `github.read`,
`skill.catalog_refreshed`, `github.rate_limited`, validation failures, and
bounded stale-cache use. Alert before the installation's remaining request
budget can fall below forecast peak demand; correlate by deployment and UTC
window, never by logging response headers or tokens. A sustained rate-limit,
authentication, or validation error pauses authoring and approval. Only
transient reads may use an already validated snapshot within the documented
stale deadline.

Cache keys include the resolved commit. A protected-branch merge becomes
visible after the normal TTL; for an urgent refresh, redeploy/restart all server
instances so their in-memory caches are empty, then verify the resolved commit
and catalog refresh event. Never mutate a cached object, delete repository files
to force refresh, or serve a snapshot validated for another ref.

For a GitHub outage, disable new skill execution when the bounded stale window
cannot cover the incident, leave Telegram general conversation available if it
is healthy, and fail all skill mutations closed. Do not restore PostgreSQL
definition rows or copy GitHub data into application tables. Resume only after
authentication, branch resolution, schema validation, rate-limit headroom, and
a canary invocation pass.

Rotate a connector by creating a new least-privilege GitHub connection, attaching
it only to Preview, deploying and completing read plus authoring smoke tests,
then attaching it to Production and deploying. Confirm catalog commit and audit
events before detaching and revoking the old connector. Record connector IDs,
environment scopes, deployment IDs, and UTC times—but never tokens—in
`docs/acceptance-evidence.md`.

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

### Repository authorization and failure modes

Every catalog list/read, draft branch, revision write, approval observation,
retirement, and invocation must enter through the skill repository/service with
an authenticated Telegram user. Missing and unauthorized targets both return
`SKILL_NOT_FOUND`; user-facing errors must not include a skill name, branch,
pull request, repository path, or document excerpt. Author, approver, retire,
and capability grants are deployed operator policy. Repository manifests may
request capabilities, but cannot grant them.

Writes are serialized in-process by skill ID and use both the previously
observed branch commit SHA and file blob SHA. `SKILL_REVISION_CONFLICT` is a
safe, retry-by-revision result: do not retry the write or disclose the winning
branch/content. Writes, approvals, unknown write outcomes, and unknown merge
commits always fail closed.

For reads only, a transient GitHub or rate-limit failure may use the last fully
schema-validated snapshot for the same symbolic ref until its bounded stale
deadline (currently two minutes after the normal cache lifetime). Never use
stale data for an explicit unknown commit, after expiry, after validation or
authentication failures, or for a mutation. Events for GitHub reads, branch and
commit writes, pull requests, observed merges, refreshes, denials, conflicts,
rate limits, and invocations contain only actor/skill/draft/PR identifiers,
commit SHAs, durations, and safe codes. Connector tokens, headers, response
bodies, branch names, repository paths, and skill content are prohibited.

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

## Prompt hierarchy signals and promotion gates

Emit only bounded labels and numeric values—never repository coordinates, raw user data, prompt content, identities, connector headers, or secrets. Dashboards must show resolution source (`personal`, `global`, `default`, `emergency`), cache/refresh latency, direct-edit age, GitHub outcome, validation rejection, fallback reason, confirmation completion, compare-and-set conflict, verified activation, and emergency-mode duration. Direct-edit freshness and emergency fallback are production-visible time series.

Evaluate a rolling 15-minute window plus a 24-hour baseline. Stop the active stage and do not promote unless all applicable gates hold for the approved observation window:

| Gate                                                              | Promotion threshold / alert                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unauthorized access or cross-user discovery                       | exactly zero; page immediately                                                                      |
| Raw-data, prompt-content, identity, coordinate, or secret leakage | exactly zero; disable suggestions/writes and incident response immediately                          |
| Direct protected-branch edit freshness                            | 100% visible within five minutes; alert at 4 minutes and stop at 5                                  |
| p95 prompt resolution latency                                     | at or below the recorded shadow bound (default 250 ms) and no more than 20% over baseline           |
| GitHub auth/rate-limit/unknown write outcome                      | zero auth/unknown outcomes; sufficient peak-window headroom                                         |
| Validation rejection and emergency fallback                       | zero during promotion fixtures; otherwise within an explicitly approved baseline                    |
| Confirmation completion/conflicts                                 | completion rate measured; no duplicate activation; conflicts remain safe and are never auto-retried |
| Verified activation                                               | exactly one activation for each approved mutation and the next turn observes it                     |
| Emergency duration                                                | alert immediately on entry and every five minutes until exit                                        |

`GET /api/health` returns only component compatibility states. The prompt component is `disabled`, `ready`, or `degraded`; it discloses no repository, branch, connector, actor, prompt, or secret. A disabled component is compatible and does not make readiness fail. Validate the deployed schema/migration separately with privileged read-only operational tooling; do not add coordinates or migration internals to the public response.
