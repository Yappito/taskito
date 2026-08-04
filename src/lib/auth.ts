import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, resetRateLimit } from "@/lib/rate-limit";
import { getClientIpFromHeaders } from "@/lib/request-ip";
import { getOidcProviderConfigs, type OidcProfile, type OidcProviderConfig } from "@/server/services/oidc-provider-settings";

const productionSecret = process.env.AUTH_SECRET;
const invalidSecrets = new Set([
  "replace-with-a-random-secret-in-production",
  "change-me-in-production",
  "replace-with-a-cryptographically-strong-secret",
  "change-me",
]);
const isProductionRuntime =
  process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";

if (isProductionRuntime) {
  if (!productionSecret || productionSecret.length < 32 || invalidSecrets.has(productionSecret)) {
    throw new Error("AUTH_SECRET must be set to a cryptographically strong value of at least 32 characters in production");
  }
}

function readProfileString(profile: OidcProfile, keys: string[]) {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readClaim(profile: OidcProfile, claimPath: string) {
  return claimPath.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, profile);
}

function readOidcGroups(profile: OidcProfile, groupsClaim: string) {
  const value = readClaim(profile, groupsClaim);
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function slugifyGroupName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "group";
}

async function buildUniqueGroupSlug(baseName: string) {
  const baseSlug = slugifyGroupName(baseName);
  let slug = baseSlug;
  let suffix = 2;

  while (await prisma.group.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

async function syncOidcGroups(userId: string, config: OidcProviderConfig, profile: OidcProfile | undefined) {
  if (!profile) return;
  const groupNames = readOidcGroups(profile, config.groupsClaim);
  if (groupNames === null) return;

  const normalizedGroupNames = [...new Set(groupNames)];
  await prisma.$transaction(async (tx) => {
    const groupIds: string[] = [];

    for (const groupName of normalizedGroupNames) {
      const existingGroup = await tx.group.findFirst({
        where: {
          source: "oidc",
          oidcProvider: config.id,
          externalId: groupName,
        },
        select: { id: true },
      });

      if (existingGroup) {
        groupIds.push(existingGroup.id);
        continue;
      }

      const group = await tx.group.create({
        data: {
          name: groupName,
          slug: await buildUniqueGroupSlug(`${config.id}-${groupName}`),
          source: "oidc",
          oidcProvider: config.id,
          externalId: groupName,
        },
        select: { id: true },
      });
      groupIds.push(group.id);
    }

    await tx.groupMember.deleteMany({
      where: {
        userId,
        group: {
          source: "oidc",
          oidcProvider: config.id,
          ...(groupIds.length > 0 ? { id: { notIn: groupIds } } : {}),
        },
      },
    });

    if (groupIds.length > 0) {
      await tx.groupMember.createMany({
        data: groupIds.map((groupId) => ({ userId, groupId })),
        skipDuplicates: true,
      });
    }
  });
}

function buildOidcProviders(oidcProviderConfigs: OidcProviderConfig[]) {
  return oidcProviderConfigs.map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: "oidc" as const,
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    authorization: { params: { scope: provider.scope } },
    checks: ["pkce", "state"] as ("pkce" | "state")[],
    allowDangerousEmailAccountLinking: provider.allowEmailAccountLinking,
    profile(profile: OidcProfile) {
      if (provider.requireEmailVerified && profile.email_verified === false) {
        throw new Error("OIDC profile email is not verified");
      }

      const email = readProfileString(profile, ["email", "preferred_username", "upn"]);
      if (!email) {
        throw new Error("OIDC profile must include an email-like identifier");
      }

      return {
        id: String(profile.sub),
        name: readProfileString(profile, ["name", "preferred_username", "email"]),
        email: email.toLowerCase(),
        image: readProfileString(profile, ["picture", "avatar_url"]),
      };
    },
  }));
}

async function buildAuthConfig(): Promise<NextAuthConfig> {
  const oidcProviderConfigs = await getOidcProviderConfigs();
  const oidcProviderConfigById = new Map(oidcProviderConfigs.map((provider) => [provider.id, provider]));

  return {
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
          const ip = getClientIpFromHeaders(request.headers);
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
          if (!user?.password || user.disabledAt) return null;

          const password = String(credentials.password);
          const { hashPassword, verifyPassword } = await import("@/lib/password");
          const verification = await verifyPassword(password, user.password);
          if (!verification.valid) return null;

          if (verification.needsRehash) {
            try {
              await prisma.user.update({
                where: { id: user.id },
                data: {
                  password: await hashPassword(password),
                },
              });
            } catch {
              // Avoid failing a valid login if the background rehash update cannot be persisted.
            }
          }

          resetRateLimit("login:account", `${email}:${ip}`);
          resetRateLimit("login:ip", ip);

          return {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
            role: user.role === "admin" ? "admin" : "member",
          };
        },
      }),
      ...buildOidcProviders(oidcProviderConfigs),
    ],
    callbacks: {
      async signIn({ user, account }) {
        const email = user.email?.toLowerCase();
        if (!email) return false;

        const existingUser = await prisma.user.findUnique({
          where: { email },
          select: { id: true, disabledAt: true },
        });

        if (existingUser?.disabledAt) {
          return false;
        }

        const oidcConfig = account?.provider ? oidcProviderConfigById.get(account.provider) : null;
        if (oidcConfig && !oidcConfig.allowSignup && !existingUser) {
          return false;
        }

        return true;
      },
      async jwt({ token, user }) {
        if (user) {
          token.id = user.id;
          token.role = user.role;
          token.name = user.name;
          token.email = user.email;
          token.picture = user.image;
        }

        if (token.id) {
          const currentUser = await prisma.user.findUnique({
            where: { id: String(token.id) },
            select: {
              name: true,
              email: true,
              image: true,
              role: true,
              disabledAt: true,
            },
          });

          if (currentUser && !currentUser.disabledAt) {
            token.name = currentUser.name;
            token.email = currentUser.email;
            token.picture = currentUser.image;
            token.role = currentUser.role === "admin" ? "admin" : "member";
          }
        }

        return token;
      },
      session({ session, token }) {
        if (session.user && token.id) {
          session.user.id = token.id as string;
          session.user.role = token.role === "admin" ? "admin" : "member";
          session.user.name = typeof token.name === "string" ? token.name : null;
          session.user.email = typeof token.email === "string" ? token.email : "";
          session.user.image = typeof token.picture === "string" ? token.picture : null;
        }
        return session;
      },
    },
    events: {
      async signIn({ user, account, profile, isNewUser }) {
        if (!user.id) return;

        const oidcConfig = account?.provider ? oidcProviderConfigById.get(account.provider) : null;
        const email = user.email?.toLowerCase() ?? "";
        const role = oidcConfig?.adminEmails.has(email)
          ? "admin"
          : isNewUser && oidcConfig
            ? oidcConfig.defaultRole
            : undefined;

        await prisma.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            ...(oidcConfig ? { authSource: oidcConfig.id, emailVerified: new Date() } : {}),
            ...(role ? { role } : {}),
          },
        });

        if (oidcConfig) {
          await syncOidcGroups(user.id, oidcConfig, profile as OidcProfile | undefined);
        }
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);
