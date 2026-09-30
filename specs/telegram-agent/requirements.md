# Requirements: Telegram Agent and Installed Skills

Status: Approved product direction; implementation is incomplete until every acceptance test in the traceability matrix passes.

## Objective and scope

Telegram Agent is a private-chat assistant backed by DeepSeek. It stores all durable state in PostgreSQL, uses a disposable Vercel Sandbox for model and tool execution, and lets a user create, review, install, discover, select, and run reusable skills from Telegram. The dashboard and authenticated export remain operator inspection surfaces.

PostgreSQL is the **only durable store**. The Sandbox filesystem is scratch space and may be discarded at any time. Earlier requirements that mandated a Sandbox Drive, file-only durability, or prohibited PostgreSQL and tool execution are withdrawn. Tools may execute only through the capability authorization rules below.

## Actors and ownership decision

- **Telegram user** creates and uses skills in a private chat.
- **Operator** deploys the service, migrates PostgreSQL, registers capabilities, manages globally available skills, and audits or disables execution.
- **Skill author/owner** is the Telegram user recorded in `owner_user_id`.

Installed user-created skills are **private per user by default and in this release**: only their owner may list, discover, select, revise, approve, install, or invoke them. There is no user-to-user sharing or public marketplace. Operator-managed skills have `visibility=global` and may be used by all users, but only an operator may publish, revise, disable, or retire them. A global skill is not jointly owned by users. Future group/team sharing requires a new visibility value, authorization policy, migration, and requirements approval.

## Existing assistant baseline

The service shall continue to accept authenticated Telegram webhooks for private text, support `/start`, `/help`, and `/new`, order turns per user, deduplicate `update_id`, call configured DeepSeek non-streamingly, discard hidden reasoning, safely split replies, and expose a secret-protected read-only dashboard and export. Secrets and raw credentials must never enter prompts, audit data, logs, Telegram replies, or exports. PostgreSQL records conversations, messages, model usage, delivery status, errors, and skill data transactionally.

## Functional requirements

| ID | Requirement | Acceptance summary |
|---|---|---|
| SKILL-F-001 | A user may start skill creation with `/skill create` or an equivalent Telegram action; the system creates a UUID-addressed draft owned by that Telegram user. | A draft and audit event commit in one transaction. |
| SKILL-F-002 | Creation shall capture a name, purpose, trigger/use cases, instructions, expected inputs, output contract, examples, and requested capabilities; missing values remain explicit unanswered fields, never model-invented facts. | Tests exercise partial and complete submissions. |
| SKILL-F-003 | Clarification questions shall be tagged with exactly one stable category: `goal`, `inputs`, `outputs`, `behavior`, `constraints`, `examples`, `capabilities`, `privacy`, or `failure_handling`; at most one category is actively requested per Telegram turn. | Category contract rejects unknown values. |
| SKILL-F-004 | The assistant shall distinguish blocking clarifications from optional improvements, show why a blocking answer is needed, and allow optional questions to be skipped. | Draft cannot enter review with blocking gaps. |
| SKILL-F-005 | When blocking gaps are resolved, the system shall render a numbered, immutable draft revision for review, including complete instructions, ownership/visibility, requested capabilities, and safety constraints. | Review references an exact revision number/hash. |
| SKILL-F-006 | Review shall offer `Approve & install`, `Request changes`, and `Cancel`; silence, ambiguous affirmative text, model output, or a tool result is not approval. | Only callback data or `/skill approve <id> <revision>` is accepted. |
| SKILL-F-007 | `Request changes` shall return the draft to revision, preserve prior revisions, accept iterative natural-language changes, rerun clarification/validation, and create a new monotonically increasing revision. | Revision history is append-only. |
| SKILL-F-008 | Explicit approval shall record approver, timestamp, revision, content hash, requested capability set, and Telegram update id, then install that exact revision atomically. Changed content always requires new approval. | Approval of a stale revision fails safely. |
| SKILL-F-009 | Cancellation shall mark the draft cancelled without deleting its revisions or audit trail; a cancelled, rejected, disabled, or superseded revision cannot execute. | State transition tests enforce terminal states. |
| SKILL-F-010 | Installation shall persist normalized skill metadata, immutable version content, grants, lifecycle state, and searchable text in PostgreSQL; retries with the same idempotency key return the original result. | No duplicate version/grant rows. |
| SKILL-F-011 | `/skills` shall list the caller's installed private skills plus enabled operator-managed global skills, with name, version, status, visibility, and capability summary; it shall never reveal another user's private skill. | Two-user isolation test. |
| SKILL-F-012 | `/skill find <query>` shall discover only skills visible to the caller using deterministic name/description/tag search and pagination; results shall include stable IDs to disambiguate equal names. | Search authorization occurs before ranking. |
| SKILL-F-013 | A skill may run only after explicit selection by `/skill use <skill-id> [version]` or a Telegram inline button containing the stable ID; fuzzy discovery, mention, name collision, or model suggestion cannot select or execute it. | Ambiguous names cause a choice prompt, not execution. |
| SKILL-F-014 | Selection shall resolve an enabled installed version visible to the caller, display the selected skill/version and required capabilities, and bind that selection to the current conversation until cleared or replaced. | Conversation selection is durable and auditable. |
| SKILL-F-015 | Every executable operation shall map to a capability in the operator-controlled registry. Unknown, disabled, ungranted, or parameter-invalid capabilities fail closed before side effects. | Registry lookup and schema validation precede dispatch. |
| SKILL-F-016 | Installation approval authorizes only the displayed capability set for that skill version. Added or broadened capabilities require a new revision and explicit approval. Operator policy may further deny a grant but never silently broaden it. | Effective authority is intersection of request, grant, and policy. |
| SKILL-F-017 | Initial capability types are `model.generate` and optional registered tools. Each tool descriptor defines risk tier, JSON input/output schemas, timeout, retry class, redaction rules, and whether separate per-invocation confirmation is required. | Registry is data-driven; no prompt can register a tool. |
| SKILL-F-018 | The tool loop shall be bounded by configured maximum steps and deadline, validate each proposed call, obtain any required confirmation, execute through the dispatcher, persist a sanitized result, and return the result to the model; it shall stop on completion, denial, timeout, invalid output, or bounds exhaustion. | Tests prove tools cannot call tools directly or bypass authorization. |
| SKILL-F-019 | Prompt construction shall obey the fixed precedence in design: platform safety, operator policy, capability constraints, selected approved skill version, conversation context, current user input, then untrusted tool output. Lower layers cannot override higher layers. | Prompt assembly snapshots verify ordering and delimiters. |
| SKILL-F-020 | Installing a changed skill creates a monotonically increasing version; installed historical versions are immutable. One version is current, rollback changes the current pointer without rewriting history, and active executions remain pinned to the version selected at start. | Concurrent publish/run test verifies pinning. |
| SKILL-F-021 | Owners may disable or archive their private skills; operators may disable global skills or any capability in an emergency. Destructive hard deletion is out of scope. | Disabled items remain auditable and cannot start new runs. |
| SKILL-F-022 | Every lifecycle transition, approval, installation, selection, authorization decision, tool attempt/result, version switch, and recovery action shall append an audit event with actor, target, correlation ID, idempotency key, timestamp, outcome, and sanitized metadata. | Audit chain can reconstruct a run without secrets. |
| SKILL-F-023 | Side-effecting boundaries shall use stable idempotency keys: Telegram update, lifecycle transition, installation, execution, tool call, and delivery. Retried work returns a recorded outcome or safely resumes from the last checkpoint. | Crash/retry tests show at-most-once side effects. |
| SKILL-F-024 | On model, tool, database, Sandbox, or Telegram failure the system shall record a sanitized failure, retry only operations declared retry-safe, resume from durable checkpoints, and tell the user whether no action, a completed action, or an unknown outcome occurred. Unknown-outcome calls are never automatically replayed. | Fault injection covers pre-call, post-call/pre-commit, and delivery failure. |
| SKILL-F-025 | Operators shall install PostgreSQL schema through versioned, transactional migrations before application rollout; application startup shall verify compatibility and shall not auto-create or destructively mutate production schema. | Empty-db and upgrade migration tests pass. |
| SKILL-F-026 | Backups and exports shall include all skill, revision, grant, selection, run, tool-call, idempotency, and audit tables consistently; restoration shall be verified in an isolated database before traffic is enabled. | Restore acceptance checks row counts, hashes, ownership, and runnable selection. |

## Non-functional requirements

| ID | Attribute | Measurable requirement |
|---|---|---|
| SKILL-NF-001 | Authorization | Automated tests with two users and an operator prove deny-by-default row access and no private-skill enumeration, selection, or execution across owners. |
| SKILL-NF-002 | Integrity | PostgreSQL foreign keys, uniqueness constraints, transactions, content hashes, and immutable-version triggers/permissions prevent dangling grants, duplicate effects, and version mutation. |
| SKILL-NF-003 | Availability | A process/Sandbox restart at every durable checkpoint can resume without losing approved definitions or repeating a non-retry-safe side effect. |
| SKILL-NF-004 | Performance | With 10,000 skills for one owner, p95 list and indexed discovery queries complete within 500 ms at the database boundary; tool latency is reported separately. |
| SKILL-NF-005 | Security | Tool execution is server-side, least-privilege, schema validated, time/depth bounded, egress-restricted where supported, and isolated from dashboard/session/database/provider credentials. |
| SKILL-NF-006 | Privacy | Private skill content and tool inputs/results are disclosed only to their owner and required providers; audit metadata is sanitized and retention follows the operator policy. |
| SKILL-NF-007 | Auditability | Audit events are append-only and queryable by correlation, actor, skill, version, execution, capability, and time; clocks use UTC and IDs are globally unique. |
| SKILL-NF-008 | Usability | Every Telegram lifecycle screen names the skill and state, uses concise buttons plus command fallbacks, survives stale callbacks safely, and never represents a draft as installed. |
| SKILL-NF-009 | Extensibility | Capability adapters implement a common typed interface and can be tested without Telegram, DeepSeek, or a live external service. |
| SKILL-NF-010 | Operability | Migrations, backup, restore, capability kill switch, stuck-run recovery, rollback, and audit queries have documented commands and acceptance evidence. |
| SKILL-NF-011 | Observability | Structured metrics distinguish clarification, approval, install, authorization denial, execution, tool latency/error, recovery, and delivery while excluding prompt/tool secrets. |
| SKILL-NF-012 | Accessibility/localization | Telegram controls have textual command equivalents and messages can be localized without changing stored identifiers or authorization semantics. |

## Lifecycle invariants and exclusions

Lifecycle states are `draft → clarifying → review → approved → installed → disabled → archived`, with `draft|clarifying|review → cancelled` and `review → clarifying` for requested changes. `approved` is an atomic transitional record immediately followed by `installed`; failure leaves a recoverable approved revision, never an apparently installed partial record. No transition may skip review or explicit approval.

Out of scope: skill sharing between users, public marketplace publishing, arbitrary shell/code execution, user-defined capability adapters, prompt-controlled grants, autonomous skill selection, background schedules, hard deletion, and unbounded agent loops. PostgreSQL and authorized tool execution are explicitly in scope.

## Acceptance and traceability gate

The feature is not complete merely because documents, tables, or UI exist. **Every row below must have its implementation module, named automated test, and passing CI evidence.** Planned paths are contracts for implementation; absence of a listed module or test blocks release.

| Requirements | Implementation modules | Automated acceptance tests |
|---|---|---|
| SKILL-F-001–004, SKILL-NF-008,012 | `src/worker/skills/creation.ts`, `clarifications.ts`; `src/worker/telegram/skill-ux.ts` | `tests/acceptance/skills/creation-and-clarification.test.ts` |
| SKILL-F-005–009 | `src/worker/skills/lifecycle.ts`, `revisions.ts`, `approval.ts` | `tests/acceptance/skills/review-approval-revision.test.ts` |
| SKILL-F-010,020,021, SKILL-NF-002 | `src/worker/skills/repository.ts`, `versioning.ts`; `db/migrations/*_installed_skills.sql` | `tests/acceptance/skills/install-version-rollback.test.ts` |
| SKILL-F-011–014, SKILL-NF-001,004 | `src/worker/skills/catalog.ts`, `selection.ts` | `tests/acceptance/skills/list-discover-select.test.ts` |
| SKILL-F-015–019, SKILL-NF-005,009 | `src/worker/capabilities/registry.ts`, `authorize.ts`, `dispatcher.ts`; `src/worker/orchestration/tool-loop.ts`, `prompt.ts` | `tests/acceptance/skills/capability-tool-loop.test.ts`, `prompt-precedence.test.ts` |
| SKILL-F-022–024, SKILL-NF-003,007,011 | `src/worker/audit/service.ts`, `src/worker/idempotency/repository.ts`, `src/worker/orchestration/recovery.ts` | `tests/acceptance/skills/audit-recovery.test.ts` |
| SKILL-F-025,026, SKILL-NF-006,010 | `db/migrations/`, `scripts/migrate.mjs`, `scripts/backup.mjs`, `scripts/restore-verify.mjs` | `tests/acceptance/skills/migration-restore.test.ts` |

## Release acceptance procedure

1. Run migrations against an empty database and a copy of the previous production schema.
2. Run unit, integration, contract, E2E, and all `tests/acceptance/skills/*` suites.
3. Create, clarify, revise, explicitly approve, install, list, discover, select, and execute both a private and operator-managed skill in Preview.
4. Prove a second user cannot observe or invoke the private skill and that an ungranted tool is denied before dispatch.
5. Inject failures at each checkpoint and verify idempotent recovery and audit reconstruction.
6. Back up Preview, restore to an isolated database, run `restore-verify`, and execute the restored selected skill with external side effects stubbed.
7. Attach command output and correlation IDs to `docs/acceptance-evidence.md`; operator sign-off is required before enabling capabilities in Production.
