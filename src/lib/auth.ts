import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, resetRateLimit } from "@/lib/rate-limit";

const productionSecret = process.env.AUTH_SECRET;
const invalidSecrets = new Set([
  "replace-with-a-random-secret-in-production",
  "change-me-in-production",
]);
const isProductionRuntime =
  process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";

if (isProductionRuntime) {
  if (!productionSecret || productionSecret.length < 32 || invalidSecrets.has(productionSecret)) {
    throw new Error("AUTH_SECRET must be set to a cryptographically strong value of at least 32 characters in production");
  }
}

function getClientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  trustHost: process.env.AUTH_TRUST_HOST === "true",
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = String(credentials.email).toLowerCase();
        const ip = getClientIp(request);
        const ipAttempt = consumeRateLimit("login:ip", ip, {
          maxAttempts: 10,
          windowMs: 15 * 60 * 1000,
        });
        const accountAttempt = consumeRateLimit("login:account", `${email}:${ip}`, {
          maxAttempts: 5,
          windowMs: 15 * 60 * 1000,
        });

        if (!ipAttempt.allowed || !accountAttempt.allowed) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email },
        });
        if (!user?.password) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );
        if (!isValid) return null;

        resetRateLimit("login:account", `${email}:${ip}`);

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role === "admin" ? "admin" : "member",
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
        session.user.role = token.role === "admin" ? "admin" : "member";
      }
      return session;
    },
  },
});
