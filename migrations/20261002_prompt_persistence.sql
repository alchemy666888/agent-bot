-- Expand-only prompt hierarchy persistence. Applied only by the privileged
-- migration job; application processes never create or alter these objects.

CREATE TABLE prompt_change_requests (
  id uuid PRIMARY KEY,
  actor_key text NOT NULL CHECK (actor_key ~ '^[A-Za-z0-9_-]{22,128}$'),
  target_key text NOT NULL CHECK (target_key ~ '^[A-Za-z0-9_:/.-]{1,512}$'),
  operation text NOT NULL CHECK (operation IN ('create','update','disable','delete','reset')),
  scope text NOT NULL CHECK (scope IN ('common','global','personal')),
  kind text NOT NULL CHECK (kind IN ('system','request')),
  prompt_id text NOT NULL CHECK (prompt_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  sanitized_summary text NOT NULL CHECK (length(sanitized_summary) BETWEEN 1 AND 256),
  -- Ciphertext only; key material is held outside PostgreSQL.
  encrypted_proposed_content bytea,
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^[0-9a-f]{64}$'),
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[0-9a-f]{40}$'),
  base_blob_sha text CHECK (base_blob_sha IS NULL OR base_blob_sha ~ '^[0-9a-f]{40}$'),
  -- Resets bind every affected path/blob (and the base tree), not a single blob.
  base_tree_sha text CHECK (base_tree_sha IS NULL OR base_tree_sha ~ '^[0-9a-f]{40}$'),
  target_manifest jsonb,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN
    ('proposed','first_confirmed','second_confirmed','committing','verified','failed','cancelled','expired')),
  first_confirmed_at timestamptz,
  second_confirmed_at timestamptz,
  committing_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  confirmation_token_digest text NOT NULL CHECK (confirmation_token_digest ~ '^[0-9a-f]{64}$'),
  confirmation_nonce text NOT NULL CHECK (confirmation_nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((operation = 'reset') = (base_tree_sha IS NOT NULL AND target_manifest IS NOT NULL)),
  CHECK (target_manifest IS NULL OR jsonb_typeof(target_manifest) = 'object'),
  CHECK (state <> 'proposed' OR first_confirmed_at IS NULL),
  CHECK (state NOT IN ('first_confirmed','second_confirmed','committing','verified','failed') OR first_confirmed_at IS NOT NULL),
  CHECK (state NOT IN ('second_confirmed','committing','verified','failed') OR second_confirmed_at IS NOT NULL),
  CHECK (state IN ('proposed','first_confirmed') OR state IN ('cancelled','expired') OR second_confirmed_at IS NOT NULL),
  CHECK ((state NOT IN ('committing','verified','failed')) = (committing_at IS NULL)),
  CHECK ((state IN ('verified','failed','cancelled','expired')) = (completed_at IS NOT NULL)),
  CHECK (second_confirmed_at IS NULL OR second_confirmed_at >= first_confirmed_at),
  CHECK (committing_at IS NULL OR committing_at >= second_confirmed_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

CREATE UNIQUE INDEX prompt_change_requests_one_live_actor_target
  ON prompt_change_requests (actor_key, target_key)
  WHERE state IN ('proposed','first_confirmed','second_confirmed','committing');
CREATE UNIQUE INDEX prompt_change_requests_confirmation_token
  ON prompt_change_requests (confirmation_token_digest);
CREATE INDEX prompt_change_requests_expiry ON prompt_change_requests (expires_at)
  WHERE state IN ('proposed','first_confirmed');

CREATE FUNCTION prompt_change_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('verified','failed','cancelled','expired') THEN
    RAISE EXCEPTION 'terminal prompt change requests are immutable';
  END IF;
  IF NOT ((OLD.state = 'proposed' AND NEW.state IN ('first_confirmed','cancelled','expired')) OR
          (OLD.state = 'first_confirmed' AND NEW.state IN ('second_confirmed','cancelled','expired')) OR
          (OLD.state = 'second_confirmed' AND NEW.state = 'committing') OR
          (OLD.state = 'committing' AND NEW.state IN ('verified','failed'))) THEN
    RAISE EXCEPTION 'illegal prompt change request transition: % -> %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER prompt_change_request_transition
  BEFORE UPDATE ON prompt_change_requests FOR EACH ROW EXECUTE FUNCTION prompt_change_request_guard();

CREATE TABLE prompt_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  repository_prefix text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  snapshot_payload jsonb NOT NULL CHECK (jsonb_typeof(snapshot_payload) = 'object'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  validated_at timestamptz NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_owner, repository_name, repository_prefix, commit_sha),
  CHECK (NOT active OR verified)
);
CREATE UNIQUE INDEX prompt_snapshots_one_active_repository
  ON prompt_snapshots(repository_owner, repository_name, repository_prefix) WHERE active;

CREATE TABLE prompt_cache_entries (
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  repository_prefix text NOT NULL,
  symbolic_ref text NOT NULL,
  current_verified_commit text CHECK (current_verified_commit IS NULL OR current_verified_commit ~ '^[0-9a-f]{40}$'),
  freshness_deadline timestamptz,
  refreshed_at timestamptz,
  error_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  lease_owner text,
  lease_expires_at timestamptz,
  PRIMARY KEY(repository_owner, repository_name, repository_prefix, symbolic_ref),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE prompt_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  correlation_id uuid NOT NULL,
  actor_ref text CHECK (actor_ref IS NULL OR actor_ref ~ '^[A-Za-z0-9_-]{22,128}$'),
  target_ref text CHECK (target_ref IS NULL OR target_ref ~ '^[A-Za-z0-9_-]{22,128}$'),
  commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompt_audit_events_created_at ON prompt_audit_events(created_at);
