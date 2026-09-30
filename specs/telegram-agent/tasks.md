# Tasks: Installed Skills

Status: Planned. A checked implementation task is not sufficient for release; its automated acceptance evidence must also pass.

## Execution rules

- GitHub is the sole durable source of skill definitions; never depend on Sandbox files after a command ends.
- Never store skill bodies, manifests, revisions, drafts, searchable copies, or archives in PostgreSQL; store only operational references and audits allowed by `architecture.md`.
- Do not expose a capability until registry, authorization, confirmation, redaction, idempotency, recovery, and audit tests pass.
- Update the traceability table whenever a requirement, module, or test changes. CI shall reject an untraced `SKILL-F-*` or `SKILL-NF-*` identifier.
- Keep capabilities disabled through migration and smoke testing; enable them deliberately after restore evidence is current.

## Implementation tasks

### TASK-SKILL-001 — GitHub repository and validation foundation

- Establish `skills/<skill-id>/{SKILL.md,manifest.json,README.md?}`, `archive/skills/`, manifest JSON Schema, CODEOWNERS, and protected-branch required checks.
- Add commit-SHA/path resolution, clean-checkout validation, GitHub webhook verification, and least-privilege GitHub App authorization.
- Add PostgreSQL operational-reference migrations that expressly omit definition, revision, draft, and search content.
- Test path/ID mismatches, schema versions, direct/stale/unauthorized changes, force-push protection, webhook replay, and clean-clone startup.

**Requirements:** SKILL-F-010,020,025; SKILL-NF-001,002,010.
**Acceptance:** `tests/acceptance/skills/github-recovery.test.ts`, `install-version-rollback.test.ts`.

### TASK-SKILL-002 — Drafting and categorized clarification

- Implement creation, required fields, nine stable clarification categories, blocking/optional gaps, skip/cancel, and one-question-per-turn UX.
- Ensure model suggestions are validated data and cannot fill unanswered facts silently.
- Commit draft transitions to a user-authorized branch and persist only references/audit events with Telegram-update idempotency.

**Requirements:** SKILL-F-001–004,009,022,023; SKILL-NF-008,012.
**Acceptance:** `tests/acceptance/skills/creation-and-clarification.test.ts`.

### TASK-SKILL-003 — Review, revision, and explicit approval

- Render immutable Git commits with ownership, visibility, capabilities, constraints, and full SHA.
- Implement signed commit-SHA-bound Telegram callbacks and command fallbacks for approve, request changes, and cancel.
- Preserve Git history, reject stale-SHA approval, and prove changed content/capabilities require approval again.

**Requirements:** SKILL-F-005–009,016; SKILL-NF-002,008.
**Acceptance:** `tests/acceptance/skills/review-approval-revision.test.ts`.

### TASK-SKILL-004 — Atomic installation, versioning, and lifecycle controls

- Merge the approved commit and exact capability request only after required GitHub checks/reviews; use commit SHAs as immutable versions.
- Implement retirement by moving to `archive/skills/<skill-id>/` with disabled status, restoration by authorized PR, and rollback by revert PR without rewriting history.
- Pin in-flight executions to commit SHAs and make installation retry-safe.

**Requirements:** SKILL-F-008–010,020,021,023; SKILL-NF-001–003.
**Acceptance:** `tests/acceptance/skills/install-version-rollback.test.ts`.

### TASK-SKILL-005 — Listing, discovery, and explicit selection

- Implement `/skills`, deterministic commit-scoped `/skill find`, pagination, stable IDs, and current SHA/status/capability summaries without database definition search.
- Enforce private-owner/global visibility before search ranking and lookup.
- Implement explicit selection/clear in the current conversation; collisions and suggestions may present buttons but never execute.

**Requirements:** SKILL-F-011–014; SKILL-NF-001,004,008,012.
**Acceptance:** `tests/acceptance/skills/list-discover-select.test.ts` including 10,000-skill performance fixture.

### TASK-SKILL-006 — Capability registry and authorization

- Build operator-only registry descriptors, common adapter interface, JSON schema validation, grant intersection, policy kill switch, and risk-tier confirmation.
- Begin with `model.generate`; add no external adapter without its own credential isolation, egress, timeout, retry, sanitization, and contract tests.
- Audit allow/deny reason before dispatch and check emergency disable immediately before effects.

**Requirements:** SKILL-F-015–017,021,022; SKILL-NF-005,007,009,011.
**Acceptance:** `tests/acceptance/skills/capability-tool-loop.test.ts`.

### TASK-SKILL-007 — Prompt assembler and bounded tool loop

- Implement labeled prompt precedence, untrusted-data encoding, prompt hashes, typed proposals, step/deadline bounds, dispatcher, result sanitization, and final response.
- Ensure neither model nor tool can register capabilities, change grants, invoke adapters directly, or recursively dispatch.
- Add per-call confirmation binding and cancellation behavior.

**Requirements:** SKILL-F-018,019; SKILL-NF-005,006,009.
**Acceptance:** `tests/acceptance/skills/prompt-precedence.test.ts`, `capability-tool-loop.test.ts`.

### TASK-SKILL-008 — Idempotency, audit, and failure recovery

- Implement scoped request hashes, processing leases, durable checkpoints, reconciliation, delivery chunk dedupe, and unknown-outcome handling.
- Append sanitized audit events for every required decision/action and add operator queries by actor, target, correlation, capability, execution, and time.
- Fault-inject process, database, model, Telegram, and tool failures before/after every side-effect boundary.

**Requirements:** SKILL-F-022–024; SKILL-NF-003,006,007,011.
**Acceptance:** `tests/acceptance/skills/audit-recovery.test.ts`.

### TASK-SKILL-009 — Telegram UX and operational inspection

- Add commands/buttons, signed callback parsing, pagination, localization-ready strings, status/history, explicit run banner, confirmation, and safe stale-state messages.
- Extend the read-only dashboard/export with skill commit references, capability decisions, selections, executions, tool calls, and audit decisions while preserving owner privacy and redaction.

**Requirements:** SKILL-F-003–014,022; SKILL-NF-006–008,011,012.
**Acceptance:** skill acceptance suites plus browser accessibility/security tests.

### TASK-SKILL-010 — Git recovery, deployment, and release gate

- Implement verified Git mirror/bundle recovery and isolated `recovery-verify`; document GitHub App permissions, branch rules, deployment order, kill switch, reference reconciliation, and PR-based rollback.
- Add a CI traceability check that maps every requirement ID to an existing module and named automated test.
- Perform Preview walkthrough, cross-user denial, fault injection, repository recovery plus operational-reference reconciliation, and operator approval; record evidence in `docs/acceptance-evidence.md`.

**Requirements:** SKILL-F-025,026; SKILL-NF-001–012.
**Acceptance:** `tests/acceptance/skills/github-recovery.test.ts` and the complete acceptance suite.

## Traceability matrix

| Requirement set | Tasks | Modules | Automated acceptance |
|---|---|---|---|
| SKILL-F-001–004; SKILL-NF-008,012 | 002,009 | `skills/creation`, `skills/clarifications`, `telegram/skill-ux` | `creation-and-clarification.test.ts` |
| SKILL-F-005–009 | 003,004,009 | `skills/lifecycle`, `skills/revisions`, `skills/approval` | `review-approval-revision.test.ts` |
| SKILL-F-010,020,021; SKILL-NF-002 | 001,004 | repository checks, `skills/git-repository`, `skills/versioning` | `install-version-rollback.test.ts` |
| SKILL-F-011–014; SKILL-NF-001,004 | 005,009 | `skills/catalog`, `skills/selection` | `list-discover-select.test.ts` |
| SKILL-F-015–019; SKILL-NF-005,009 | 006,007 | `capabilities/*`, `orchestration/tool-loop`, `prompt` | `capability-tool-loop.test.ts`, `prompt-precedence.test.ts` |
| SKILL-F-022–024; SKILL-NF-003,007,011 | 002,004,006,008 | `audit/service`, `idempotency/repository`, `orchestration/recovery` | `audit-recovery.test.ts` |
| SKILL-F-025,026; SKILL-NF-006,010 | 001,009,010 | .github rules, validation/mirror/recovery scripts | `github-recovery.test.ts` |

## Definition of done

No installed-skills requirement is complete until its production module exists, its listed automated acceptance test passes in CI, Preview evidence is recorded, Git repository recovery and PostgreSQL-reference reconciliation succeed, ownership isolation and capability denial are demonstrated, and an operator explicitly signs off. Documentation-only completion is prohibited.
