/**
 * Same-origin check for cookie-authenticated route handlers (CSRF defense).
 *
 * The browser always sends the page's own origin in `Origin`/`Referer`, so
 * comparing it against the app's origins rejects cross-site requests.
 *
 * Behind a reverse proxy, `request.url` is rebuilt from the internal Host
 * header and does not match the public origin the browser used. The trusted
 * origins therefore also include the standard `x-forwarded-host` /
 * `x-forwarded-proto` headers and the configured public base URL (`AUTH_URL`).
 */
export function isTrustedRequestUrl(
  request: Pick<Request, "url" | "headers">,
  candidateUrl: string,
): boolean {
  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidateUrl).origin;
  } catch {
    return false;
  }

  const trustedOrigins = new Set<string>();
  try {
    trustedOrigins.add(new URL(request.url).origin);
  } catch {
    // request.url is expected to parse; forwarded headers still apply below.
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const requestOrigin = [...trustedOrigins][0];
    const protocol =
      forwardedProto === "https" || forwardedProto === "http"
        ? forwardedProto
        : requestOrigin?.split("://")[0];
    if (protocol) {
      trustedOrigins.add(`${protocol}://${forwardedHost}`);
    }
  }

  const authUrl = process.env.AUTH_URL?.trim();
  if (authUrl) {
    try {
      trustedOrigins.add(new URL(authUrl).origin);
    } catch {
      // Ignore a malformed AUTH_URL; the other origins still apply.
    }
  }

  return trustedOrigins.has(candidateOrigin);
}
