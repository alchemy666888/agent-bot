const filePath = /^(data|logs)(\/[A-Za-z0-9._-]+)+$/;

/** Relative paths the app may store in the configured Drive folder. */
export function assertDriveRelativePath(relativePath: string): void {
  if (!filePath.test(relativePath) || relativePath.includes(".."))
    throw new Error("DRIVE_PATH_REJECTED");
}
