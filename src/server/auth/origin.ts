import "server-only";

export function browserUrl(request: Request, path: string): URL {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      return new URL(path, origin);
    } catch {
      /* The request URL is only a fallback when Origin is unusable. */
    }
  }
  const forwarded = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  if (forwarded) {
    const proto = request.headers.get("x-forwarded-proto") ?? "http";
    return new URL(path, `${proto}://${forwarded}`);
  }
  return new URL(path, request.url);
}

/**
 * Browsers tag real same-document posts with `Sec-Fetch-Site: same-origin`.
 * Next may report `request.url` as localhost while the browser origin is
 * 127.0.0.1, so a matching fetch-site is the reliable same-origin signal.
 */
export function isSameOriginSubmission(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const originHost = new URL(origin).host;
    const forwarded = request.headers
      .get("x-forwarded-host")
      ?.split(",")[0]
      ?.trim();
    return (
      originHost === new URL(request.url).host ||
      (forwarded !== undefined && originHost === forwarded)
    );
  } catch {
    return false;
  }
}
