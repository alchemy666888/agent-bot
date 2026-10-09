-- Skill definitions, drafts, and published versions live in PostgreSQL.
-- Applied only by the privileged migration job; application startup never
-- creates or alters these objects. Prompt snapshots stay on GitHub.

CREATE TABLE skills (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  owner_telegram_user_id text NOT NULL CHECK (owner_telegram_user_id ~ '^[0-9]+$'),
  visibility text NOT NULL CHECK (visibility IN ('private', 'shared', 'public')),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skill_versions (
  id uuid PRIMARY KEY,
  skill_id uuid NOT NULL REFERENCES skills (id),
  revision integer NOT NULL CHECK (revision > 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 1000000),
  state text NOT NULL CHECK (state IN ('draft', 'pending', 'published', 'retired')),
  created_by text NOT NULL CHECK (created_by ~ '^[0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, revision)
);

ALTER TABLE skills
  ADD CONSTRAINT skills_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES skill_versions (id);

CREATE INDEX skill_versions_skill_state ON skill_versions (skill_id, state);

CREATE FUNCTION skill_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.manifest IS DISTINCT FROM NEW.manifest
     OR OLD.instructions IS DISTINCT FROM NEW.instructions
     OR OLD.content_digest IS DISTINCT FROM NEW.content_digest
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.skill_id IS DISTINCT FROM NEW.skill_id
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'skill version content is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'draft' AND NEW.state = 'pending') OR
    (OLD.state = 'pending' AND NEW.state = 'published') OR
    OLD.state = NEW.state
  ) THEN
    RAISE EXCEPTION 'illegal skill version transition: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skill_version_immutable
  BEFORE UPDATE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skill_version_guard();

CREATE TABLE skill_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  actor_telegram_user_id text CHECK (
    actor_telegram_user_id IS NULL OR actor_telegram_user_id ~ '^[0-9]+$'
  ),
  skill_id uuid,
  version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skill_audit_events_created_at ON skill_audit_events (created_at);
