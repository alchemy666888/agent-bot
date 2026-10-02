export type PromptChangeState =
  | "proposed"
  | "first_confirmed"
  | "second_confirmed"
  | "committing"
  | "verified"
  | "failed"
  | "cancelled"
  | "expired";

export interface RepositoryIdentity {
  owner: string;
  name: string;
  prefix: string;
}

export interface SnapshotInput extends RepositoryIdentity {
  commitSha: string;
  payload: unknown;
  contentDigest: string;
  validatedAt: Date;
}

export interface RefreshLease extends RepositoryIdentity {
  symbolicRef: string;
  ownerId: string;
  expiresAt: Date;
}
