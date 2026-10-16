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

export function isMissingSandboxError(error: unknown): boolean {
  const code = sandboxProviderCode(error);
  return (
    sandboxProviderStatus(error) === 404 ||
    code === "not_found" ||
    code === "sandbox_not_found"
  );
}
