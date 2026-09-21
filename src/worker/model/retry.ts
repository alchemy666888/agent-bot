export async function retryTransient<T>(
  operation: () => Promise<T>,
  isTransient: (error: unknown) => boolean,
  delay = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (!isTransient(error) || attempt === 2) throw error;
      await delay(25 * (attempt + 1));
    }
  }
  throw last;
}
