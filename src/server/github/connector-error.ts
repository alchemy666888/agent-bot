import "server-only";

/**
 * Vercel Connect returns 404 not_found when the connector does not exist or
 * is not attached to this project. Keep that distinct from a GitHub API 404.
 */
export function translateConnectorError(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  if (
    name !== "ConnectError" &&
    name !== "ConnectorInstallationRequiredError" &&
    name !== "NoValidTokenError"
  )
    return error;
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : "";
  if (status === 404 && code === "not_found")
    return new Error("GITHUB_CONNECTOR_NOT_FOUND");
  if (
    status === 403 &&
    code === "forbidden" &&
    /connector is not linked to this project/i.test(message)
  )
    return new Error("GITHUB_CONNECTOR_NOT_FOUND");
  if (
    name === "ConnectorInstallationRequiredError" ||
    code === "connector_installation_required" ||
    code === "client_installation_required"
  )
    return new Error("GITHUB_CONNECTOR_NOT_INSTALLED");
  return new Error("GITHUB_AUTHENTICATION_FAILED");
}
