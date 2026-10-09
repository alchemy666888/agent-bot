# Architecture: PostgreSQL-backed skill definitions

Status: Approved target architecture. Prompt documents remain on GitHub.

## Source of truth and repository contract

PostgreSQL is the sole durable source of truth for skill definitions. A skill is usable only when its current `skill_versions` row is `published` and the parent `skills` row is `active`. Version ids are immutable. Draft and pending rows are not executable. GitHub is not read or written on the skill path; a one-time import may copy an existing GitHub tree into these tables.

`skills` holds the stable id, name, owner, visibility, and lifecycle status. `skill_versions` holds each revision's manifest and `SKILL.md` body. Published and retired content columns are immutable. A catalog snapshot's token is the digest of the version ids in that snapshot. Execution pins `versionId` and does not advance to a later revision. Unknown schema versions, invalid fields, and undeclared capabilities fail closed.

Owner approval moves a draft revision to `pending`. An approver publish sets that version to `published` and points `skills.current_version_id` at it. Retirement inserts a `retired` version and marks the skill retired. Rows are not deleted and retired ids are not reused.

## Resolution and execution

Catalog listing reads current published versions and returns only those the actor may see. Invocation loads the pinned version id, checks that it is still published on an active skill, and authorizes capabilities as the intersection of the manifest request, operator policy, and the actor. It never substitutes a newer version.

## Authorization and recovery

Author, approver, retiree, and capability grants come from operator policy, not from the stored manifest. Audit events record the action, actor, skill id, and version id without copying the instruction body.

Recovery is a PostgreSQL restore of `skills`, `skill_versions`, and `skill_audit_events`. After restore, execution still fails closed unless the pinned version id exists, is published, and the skill is active. Prompt recovery stays on GitHub.
