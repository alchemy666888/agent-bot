/** A timer-backed signal that the caller can cancel when the work finishes. */
export function deadline(ms: number, reason = "PROVIDER_REQUEST_TIMEOUT") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(reason)), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

/** Rejects when `signal` aborts, even if `work` never settles. */
export function settleOnAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const fail = () => reject(abortError(signal));
    signal.addEventListener("abort", fail, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", fail);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", fail);
        reject(error);
      },
    );
  });
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("PROVIDER_REQUEST_TIMEOUT");
}
