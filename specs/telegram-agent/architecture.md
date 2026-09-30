# Architecture: GitHub-backed skill definitions

Status: Approved target architecture.

## Source of truth and repository contract

GitHub is the sole durable source of truth for skill definitions. A skill is usable only when its files exist on the protected default branch at an approved commit. Git commit SHAs are immutable skill versions; mutable branch names, tags, pull-request numbers, and PostgreSQL rows are never version identifiers.

```text
skills/
  <skill-id>/
    SKILL.md          # model instructions
    manifest.json     # identity, metadata, policy request, and lifecycle status
    README.md         # optional human-facing documentation
archive/
  skills/
    <skill-id>/       # retired skill files, moved without changing skill-id
```

`<skill-id>` is a stable, lowercase, URL-safe identifier and must equal `manifest.json`'s `id`. `SKILL.md` contains only model instructions. `manifest.json` has a versioned JSON schema and requires `schemaVersion`, `id`, `displayName`, `owner`, `triggers`, `capabilities`, and `status`. The active tree permits only `status: active`; unknown schema versions, invalid fields, missing files, path/ID mismatches, and undeclared capabilities fail closed. `README.md` is descriptive and non-normative.

The protected default branch contains only reviewed and approved operational state. Drafts and proposed revisions exist on short-lived branches and pull requests, never in PostgreSQL or the default branch. Required checks validate layout, schemas, IDs, ownership, capability policy, links, and generated catalog indexes. CODEOWNERS/rulesets require the skill owner and designated operator reviewers; only the merge service may update the protected branch. Direct and force pushes are prohibited.

Retired skills do **not** remain under `skills/`. A retirement PR moves the directory to `archive/skills/<skill-id>/` and changes its manifest status to `disabled`. Archived definitions remain reviewable but cannot be discovered, selected, or executed. Restoration requires a new authorized PR that moves the directory back, sets `status` to `active`, and passes all checks. Hard deletion and reuse of a retired ID are prohibited.

## Resolution and execution

Catalog listing and deterministic discovery read a validated checkout or generated index for one default-branch commit. Selection records the repository-relative path, full commit SHA, and skill ID. At invocation, the worker obtains a verified copy of that exact commit, verifies that path and manifest match the selected ID and were active at that commit, then pins the run to it. It never silently falls forward to a branch head. Capability authorization remains the intersection of the manifest request, operator policy, actor authorization, parameter validation, and required confirmation.

## PostgreSQL boundary

PostgreSQL is an operational store, not a skill-definition store. It **must not** contain `SKILL.md` bodies, manifest bodies, definition snapshots, revisions, diffs, draft or review content, searchable copies, embeddings, or archives. Those belong only to Git/GitHub.

When operationally required, PostgreSQL may retain only references and events: repository identity/path, full commit SHA, selected skill ID, conversation selection, invocation and capability audit data, idempotency/delivery state, and pull-request number/status. These rows are not proof that a definition is approved; authorization resolves the referenced commit against repository policy. Audit data is sanitized and must not copy skill content.

## Change, authorization, and recovery

Creation, revision, capability changes, activation, retirement, and restoration use pull requests. Telegram may collect answers transiently, but durable draft material is committed to a user-authorized branch. Explicit Telegram approval may authorize opening or approving a PR, but cannot bypass GitHub review or branch protection. Webhook processing is idempotent and signature-verified and records only the resulting PR/commit reference.

Recovery is Git-native: restore the protected default branch or an individual skill by reverting or cherry-picking known reviewed commits through a pull request. Disaster recovery restores the repository from a verified GitHub mirror/bundle and confirms commit reachability, signatures, branch protection, and validation checks before execution resumes. PostgreSQL backup/restore covers operational references and audits only; after restoration every reference is reconciled to an existing immutable commit, and unresolved references fail closed.
