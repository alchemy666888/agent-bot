# Requirements: Telegram Agent and Installed Skills

Status: Approved product direction; implementation is incomplete until every acceptance test in the traceability matrix passes.

## Objective and scope

Telegram Agent is a private-chat assistant backed by DeepSeek. GitHub is the source of truth for skill definitions, while PostgreSQL stores only operational references and audit state. A disposable Vercel Sandbox may execute models and tools and cache verified repository content. The dashboard and authenticated export remain operator inspection surfaces.

The normative repository layout, branch policy, retirement policy, and storage boundary are defined in `architecture.md`. Skill bodies, manifests, revisions, and drafts must never be stored in PostgreSQL. Tools may execute only through the capability authorization rules below.

## Actors and ownership decision

- **Telegram user** creates and uses skills in a private chat.
- **Operator** deploys the service, migrates PostgreSQL, registers capabilities, manages globally available skills, and audits or disables execution.
- **Skill author/owner** is the Telegram user recorded in `owner_user_id`.

Installed user-created skills are **private per user by default and in this release**: only their owner may list, discover, select, revise, approve, install, or invoke them. There is no user-to-user sharing or public marketplace. Operator-managed skills have `visibility=global` and may be used by all users, but only an operator may publish, revise, disable, or retire them. A global skill is not jointly owned by users. Future group/team sharing requires a new visibility value, authorization policy, migration, and requirements approval.

## Existing assistant baseline

The service shall continue to accept authenticated Telegram webhooks for private text, support `/start`, `/help`, and `/new`, order turns per user, deduplicate `update_id`, call configured DeepSeek non-streamingly, discard hidden reasoning, safely split replies, and expose a secret-protected read-only dashboard and export. Secrets and raw credentials must never enter prompts, audit data, logs, Telegram replies, or exports. PostgreSQL records conversations, messages, model usage, delivery status, errors, and permitted operational skill references transactionally.

## Functional requirements

| ID | Requirement | Acceptance summary |
|---|---|---|
| SKILL-F-001 | A user may start skill creation with `/skill create` or an equivalent Telegram action; the system creates a stable-ID draft on a user-authorized Git branch. | The branch is created idempotently and the audit records only its repository reference. |
| SKILL-F-002 | Creation shall capture a name, purpose, trigger/use cases, instructions, expected inputs, output contract, examples, and requested capabilities; missing values remain explicit unanswered fields, never model-invented facts. | Tests exercise partial and complete submissions. |
| SKILL-F-003 | Clarification questions shall be tagged with exactly one stable category: `goal`, `inputs`, `outputs`, `behavior`, `constraints`, `examples`, `capabilities`, `privacy`, or `failure_handling`; at most one category is actively requested per Telegram turn. | Category contract rejects unknown values. |
| SKILL-F-004 | The assistant shall distinguish blocking clarifications from optional improvements, show why a blocking answer is needed, and allow optional questions to be skipped. | Draft cannot enter review with blocking gaps. |
| SKILL-F-005 | When blocking gaps are resolved, the system shall commit the repository layout and render an immutable commit for review, including instructions, ownership/visibility, requested capabilities, and safety constraints. | Review references a full Git commit SHA. |
| SKILL-F-006 | Review shall offer `Approve & install`, `Request changes`, and `Cancel`; silence, ambiguous affirmative text, model output, or a tool result is not approval. | Only callback data or `/skill approve <id> <commit-sha>` is accepted. |
| SKILL-F-007 | `Request changes` shall return work to its draft branch, preserve Git history, accept iterative changes, and rerun validation. | Each review revision is a commit; reviewed history is not rewritten. |
| SKILL-F-008 | Explicit approval shall bind approver, timestamp, full commit SHA, requested capabilities, and Telegram update ID, then create or update the pull request. GitHub authorization, review, checks, and branch protection govern merge. | Stale-SHA approval and unauthorized merge fail safely. |
| SKILL-F-009 | Cancellation shall close the draft pull request/branch without deleting merged history or operational audit data; unmerged, rejected, disabled, or superseded commits cannot execute. | State transition tests enforce terminal states. |
| SKILL-F-010 | Installation shall resolve a validated skill directory from an approved commit on the protected default branch; retries with the same idempotency key return the original commit reference. | No definition content is written to PostgreSQL and duplicate merges/selections are prevented. |
| SKILL-F-011 | `/skills` shall list the caller's installed private skills plus enabled operator-managed global skills, with name, commit SHA, status, visibility, and capability summary; it shall never reveal another user's private skill. | Two-user isolation test. |
| SKILL-F-012 | `/skill find <query>` shall discover only active skills visible to the caller from the validated default-branch catalog using deterministic metadata search and pagination; results include stable IDs. | Authorization occurs before ranking; PostgreSQL is not searched for definitions. |
| SKILL-F-013 | A skill may run only after explicit selection by `/skill use <skill-id> [commit-sha]` or a Telegram inline button containing the stable ID; fuzzy discovery, mention, name collision, or model suggestion cannot select or execute it. | Ambiguous names cause a choice prompt, not execution. |
| SKILL-F-014 | Selection shall resolve an active approved commit visible to the caller, display the selected skill/commit and required capabilities, and bind that selection to the current conversation until cleared or replaced. | Conversation selection is durable and auditable. |
| SKILL-F-015 | Every executable operation shall map to a capability in the operator-controlled registry. Unknown, disabled, ungranted, or parameter-invalid capabilities fail closed before side effects. | Registry lookup and schema validation precede dispatch. |
| SKILL-F-016 | Installation approval authorizes only the displayed capability set for that skill commit. Added or broadened capabilities require a new commit and explicit approval. Operator policy may further deny a grant but never silently broaden it. | Effective authority is intersection of request, grant, and policy. |
| SKILL-F-017 | Initial capability types are `model.generate` and optional registered tools. Each tool descriptor defines risk tier, JSON input/output schemas, timeout, retry class, redaction rules, and whether separate per-invocation confirmation is required. | Registry is data-driven; no prompt can register a tool. |
| SKILL-F-018 | The tool loop shall be bounded by configured maximum steps and deadline, validate each proposed call, obtain any required confirmation, execute through the dispatcher, persist a sanitized result, and return the result to the model; it shall stop on completion, denial, timeout, invalid output, or bounds exhaustion. | Tests prove tools cannot call tools directly or bypass authorization. |
| SKILL-F-019 | Prompt construction shall obey the fixed precedence in design: platform safety, operator policy, capability constraints, selected approved skill commit, conversation context, current user input, then untrusted tool output. Lower layers cannot override higher layers. | Prompt assembly snapshots verify ordering and delimiters. |
| SKILL-F-020 | Every merged change has an immutable Git commit SHA. The default-branch head is current, rollback uses an authorized revert PR without rewriting history, and executions remain pinned to their starting SHA. | Concurrent merge/run tests verify pinning. |
| SKILL-F-021 | Owners may retire private skills and operators may retire global skills by authorized PR; retirement moves the directory to `archive/skills/` with `status=disabled`. Operators may disable capabilities immediately. | Archived items remain in Git history and cannot start new runs. |
| SKILL-F-022 | Every lifecycle transition, approval, installation, selection, authorization decision, tool attempt/result, commit switch, and recovery action shall append an audit event with actor, target, correlation ID, idempotency key, timestamp, outcome, and sanitized metadata. | Audit chain can reconstruct a run without secrets. |
| SKILL-F-023 | Side-effecting boundaries shall use stable idempotency keys: Telegram update, lifecycle transition, installation, execution, tool call, and delivery. Retried work returns a recorded outcome or safely resumes from the last checkpoint. | Crash/retry tests show at-most-once side effects. |
| SKILL-F-024 | On model, tool, database, Sandbox, or Telegram failure the system shall record a sanitized failure, retry only operations declared retry-safe, resume from durable checkpoints, and tell the user whether no action, a completed action, or an unknown outcome occurred. Unknown-outcome calls are never automatically replayed. | Fault injection covers pre-call, post-call/pre-commit, and delivery failure. |
| SKILL-F-025 | Operators shall protect the default branch against direct/force pushes and require schema/layout, authorization, CODEOWNERS, and capability-policy checks before merge. GitHub webhooks shall be authenticated and idempotent. | Ruleset and unauthorized/stale PR tests pass. |
| SKILL-F-026 | Recovery shall use a verified Git mirror/bundle plus authorized revert/cherry-pick PRs. PostgreSQL recovery covers operational references/audits only and reconciles every restored reference to a reachable commit before traffic resumes. | Recovery checks reachability, branch protection, validation, ownership, and runnable selection. |

## Non-functional requirements

| ID | Attribute | Measurable requirement |
|---|---|---|
| SKILL-NF-001 | Authorization | Automated tests with two users and an operator prove deny-by-default row access and no private-skill enumeration, selection, or execution across owners. |
| SKILL-NF-002 | Integrity | Git hashes, authorized merges, protected history, required checks, and PostgreSQL constraints on operational references prevent definition mutation and duplicate effects. |
| SKILL-NF-003 | Availability | A process/Sandbox restart at every durable checkpoint can resume without losing approved definitions or repeating a non-retry-safe side effect. |
| SKILL-NF-004 | Performance | With 10,000 skills, p95 list and deterministic discovery against a validated commit-scoped catalog complete within 500 ms; tool latency is reported separately. |
| SKILL-NF-005 | Security | Tool execution is server-side, least-privilege, schema validated, time/depth bounded, egress-restricted where supported, and isolated from dashboard/session/database/provider credentials. |
| SKILL-NF-006 | Privacy | Private skill content and tool inputs/results are disclosed only to their owner and required providers; audit metadata is sanitized and retention follows the operator policy. |
| SKILL-NF-007 | Auditability | Audit events are append-only and queryable by correlation, actor, skill, commit SHA, execution, capability, and time; clocks use UTC and IDs are globally unique. |
| SKILL-NF-008 | Usability | Every Telegram lifecycle screen names the skill and state, uses concise buttons plus command fallbacks, survives stale callbacks safely, and never represents a draft as installed. |
| SKILL-NF-009 | Extensibility | Capability adapters implement a common typed interface and can be tested without Telegram, DeepSeek, or a live external service. |
| SKILL-NF-010 | Operability | Branch protection, repository recovery, revert rollback, capability kill switch, stuck-run recovery, reference reconciliation, and audit queries have documented commands and acceptance evidence. |
| SKILL-NF-011 | Observability | Structured metrics distinguish clarification, approval, install, authorization denial, execution, tool latency/error, recovery, and delivery while excluding prompt/tool secrets. |
| SKILL-NF-012 | Accessibility/localization | Telegram controls have textual command equivalents and messages can be localized without changing stored identifiers or authorization semantics. |

## Lifecycle invariants and exclusions

Lifecycle states map to Git workflow: `draft → clarifying → pull_request_review → approved → merged/active → retired/archived`, with pre-merge cancellation and review returning to clarification. Approval is SHA-bound; only a protected-default-branch merge makes a skill active. No transition may skip review, required checks, authorization, or explicit approval.

Out of scope: skill sharing between users, public marketplace publishing, arbitrary shell/code execution, user-defined capability adapters, prompt-controlled grants, autonomous skill selection, background schedules, hard deletion, and unbounded agent loops. PostgreSQL remains in scope only for the operational data allowed by `architecture.md`; authorized tool execution remains in scope.

## Acceptance and traceability gate

The feature is not complete merely because documents, tables, or UI exist. **Every row below must have its implementation module, named automated test, and passing CI evidence.** Planned paths are contracts for implementation; absence of a listed module or test blocks release.

| Requirements | Implementation modules | Automated acceptance tests |
|---|---|---|
| SKILL-F-001–004, SKILL-NF-008,012 | `src/worker/skills/creation.ts`, `clarifications.ts`; `src/worker/telegram/skill-ux.ts` | `tests/acceptance/skills/creation-and-clarification.test.ts` |
| SKILL-F-005–009 | `src/worker/skills/lifecycle.ts`, `revisions.ts`, `approval.ts` | `tests/acceptance/skills/review-approval-revision.test.ts` |
| SKILL-F-010,020,021, SKILL-NF-002 | `src/worker/skills/git-repository.ts`, `versioning.ts`; repository validation workflows | `tests/acceptance/skills/install-version-rollback.test.ts` |
| SKILL-F-011–014, SKILL-NF-001,004 | `src/worker/skills/catalog.ts`, `selection.ts` | `tests/acceptance/skills/list-discover-select.test.ts` |
| SKILL-F-015–019, SKILL-NF-005,009 | `src/worker/capabilities/registry.ts`, `authorize.ts`, `dispatcher.ts`; `src/worker/orchestration/tool-loop.ts`, `prompt.ts` | `tests/acceptance/skills/capability-tool-loop.test.ts`, `prompt-precedence.test.ts` |
| SKILL-F-022–024, SKILL-NF-003,007,011 | `src/worker/audit/service.ts`, `src/worker/idempotency/repository.ts`, `src/worker/orchestration/recovery.ts` | `tests/acceptance/skills/audit-recovery.test.ts` |
| SKILL-F-025,026, SKILL-NF-006,010 | `.github/`, `scripts/validate-skills.mjs`, `scripts/repository-backup.mjs`, `scripts/recovery-verify.mjs` | `tests/acceptance/skills/github-recovery.test.ts` |

## Release acceptance procedure

1. Validate the skill tree and GitHub ruleset/CODEOWNERS configuration from a clean clone.
2. Run unit, integration, contract, E2E, and all `tests/acceptance/skills/*` suites.
3. Create, clarify, revise, explicitly approve, install, list, discover, select, and execute both a private and operator-managed skill in Preview.
4. Prove a second user cannot observe or invoke the private skill and that an ungranted tool is denied before dispatch.
5. Inject failures at each checkpoint and verify idempotent recovery and audit reconstruction.
6. Restore a repository mirror/bundle and operational-reference database in isolation, reconcile SHAs, run `recovery-verify`, and execute the restored selection with external side effects stubbed.
7. Attach command output and correlation IDs to `docs/acceptance-evidence.md`; operator sign-off is required before enabling capabilities in Production.
