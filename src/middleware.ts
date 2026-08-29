import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { looksLikeBearerApiToken } from "@/lib/api-token-format";

function getOriginalProtocol(req: Request & { nextUrl: URL }) {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "https" || forwardedProto === "http") {
    return `${forwardedProto}:`;
  }

  return req.nextUrl.protocol;
}

function getSessionCookieName(isSecureRequest: boolean) {
  return isSecureRequest ? "__Secure-authjs.session-token" : "authjs.session-token";
}

export default async function middleware(req: Request & { nextUrl: URL }) {
  const originalProtocol = getOriginalProtocol(req);
  const isSecureRequest = originalProtocol === "https:";
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: isSecureRequest,
    cookieName: getSessionCookieName(isSecureRequest),
  });
  const isLoggedIn = !!token;
  const { pathname } = req.nextUrl;
  const authorization = req.headers.get("authorization");

  // Public routes that don't require auth
  const publicRoutes = ["/login", "/api/auth", "/manifest.json", "/sw.js", "/icon.svg", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"];
  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route));

  // Allow public routes and API/trpc health endpoint
  if (isPublicRoute) return NextResponse.next();

  // Allow tRPC health check without auth
  if (pathname.startsWith("/api/trpc") && pathname.includes("project.health")) {
    return NextResponse.next();
  }

  // Personal API tokens (bearer auth): API clients — scripts, external tools,
  // CI, MCP — send `Authorization: Bearer tk_…` instead of a session cookie.
  // Let valid-looking tokens through to the JSON/tRPC handlers under /api;
  // the handlers verify the token (hash, expiry, revocation) themselves.
  // Page routes stay cookie-gated: the cookie gate below is unchanged.
  if (
    !isLoggedIn
    && pathname.startsWith("/api/")
    && looksLikeBearerApiToken(authorization)
  ) {
    return NextResponse.next();
  }

  // Redirect unauthenticated users to login
  if (!isLoggedIn) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
