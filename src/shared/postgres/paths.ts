const filePath = /^(data|logs)(\/[A-Za-z0-9._-]+)+$/;

/** Relative paths the app may store in the configured persistence store. */
export function assertPersistencePath(relativePath: string): void {
  if (!filePath.test(relativePath) || relativePath.includes(".."))
    throw new Error("PERSISTENCE_PATH_REJECTED");
}
