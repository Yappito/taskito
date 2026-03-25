import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

export default async function middleware(req: Request & { nextUrl: URL }) {
  const token = await getToken({ req, secret: process.env.AUTH_SECRET });
  const isLoggedIn = !!token;
  const { pathname } = req.nextUrl;
  const role = typeof token?.role === "string" ? token.role : undefined;

  // Public routes that don't require auth
  const publicRoutes = ["/login", "/api/auth"];
  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route));

  // Allow public routes and API/trpc health endpoint
  if (isPublicRoute) return NextResponse.next();

  // Allow tRPC health check without auth
  if (pathname.startsWith("/api/trpc") && pathname.includes("project.health")) {
    return NextResponse.next();
  }

  // Redirect unauthenticated users to login
  if (!isLoggedIn) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/settings" && role !== "admin") {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
