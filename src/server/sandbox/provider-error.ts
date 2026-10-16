const PLAIN_SANDBOX_CAUSES: ReadonlyArray<[RegExp, string]> = [
  [/no active session/i, "sandbox_session_missing"],
  [/API client not initialized/, "sandbox_client_missing"],
  [/cwd dir must be absolute/, "sandbox_cwd_invalid"],
  [/Missing credentials parameters/, "sandbox_credentials_missing"],
  [
    /Invalid Vercel OIDC token|Could not get credentials from OIDC/,
    "sandbox_oidc_invalid",
  ],
  [/Request aborted/, "sandbox_request_aborted"],
];

/** Provider codes copied by the Sandbox SDK onto APIError.json. */
export function sandboxProviderCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  const nested = (error as { json?: { error?: { code?: unknown } } }).json
    ?.error?.code;
  const code = typeof nested === "string" ? nested : direct;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)
    ? code
    : undefined;
}

export function sandboxProviderStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } }).response
    ?.status;
  return typeof status === "number" && status >= 100 && status <= 599
    ? status
    : undefined;
}

/**
 * The SDK recreates a named sandbox only when this code arrives as HTTP 410.
 * The live API also returns it as HTTP 400, which leaves the name stuck.
 */
export function isStaleSnapshotError(error: unknown): boolean {
  return sandboxProviderCode(error) === "snapshot_not_found";
}

/**
 * Copies the provider code and HTTP status onto the Error safeError already
 * reads. Plain SDK failures such as "No active session" have neither, so the
 * fallback log would only say kind Error.
 */
export function annotateSandboxError<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  const record = error as Error & { code?: unknown; status?: unknown };
  if (
    typeof record.code !== "string" ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(record.code)
  ) {
    const cause =
      sandboxProviderCode(error) ??
      PLAIN_SANDBOX_CAUSES.find(([pattern]) =>
        pattern.test(error.message),
      )?.[1];
    if (cause) record.code = cause;
  }
  if (typeof record.status !== "number") {
    const status = sandboxProviderStatus(error);
    if (status !== undefined) record.status = status;
  }
  return error;
}

export function isMissingSandboxError(error: unknown): boolean {
  const code = sandboxProviderCode(error);
  return (
    sandboxProviderStatus(error) === 404 ||
    code === "not_found" ||
    code === "sandbox_not_found"
  );
}
