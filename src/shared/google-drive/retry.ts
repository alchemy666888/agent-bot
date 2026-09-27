export function driveStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

export function isTransientDriveError(error: unknown): boolean {
  const status = driveStatus(error);
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
}

export async function retryDrive<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (!isTransientDriveError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw last;
}
