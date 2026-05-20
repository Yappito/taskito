import type { OidcProviderConnection, Prisma } from "@prisma/client";

import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";
import { prisma } from "@/lib/prisma";

export interface OidcProviderConfig {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  groupsClaim: string;
  defaultRole: "admin" | "member";
  allowSignup: boolean;
  allowEmailAccountLinking: boolean;
  requireEmailVerified: boolean;
  adminEmails: Set<string>;
  source: "env" | "database";
}

export interface OidcProviderSummary {
  id: string;
  name: string;
  source: "env" | "database";
}

export type OidcProfile = Record<string, unknown>;

function parseBoolean(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeOidcProviderId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "oidc";
}

export function normalizeOidcRole(value: unknown): "admin" | "member" {
  return value === "admin" ? "admin" : "member";
}

export function normalizeAdminEmails(value: unknown) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((email) => String(email).trim().toLowerCase()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return [...new Set(value.split(/[\n,]/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
  }
  return [];
}

export function validateOidcIssuer(issuer: string) {
  const parsed = new URL(issuer);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("OIDC issuer must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function readEnvOidcProviderConfigs(): OidcProviderConfig[] {
  const rawProviders = process.env.OIDC_PROVIDERS;
  if (rawProviders) {
    const parsed = JSON.parse(rawProviders) as Array<Record<string, unknown>>;
    return parsed.map((provider, index) => {
      const id = normalizeOidcProviderId(String(provider.id ?? `oidc-${index + 1}`));
      const clientSecret = typeof provider.clientSecretEnv === "string"
        ? process.env[provider.clientSecretEnv]
        : provider.clientSecret;

      if (!provider.issuer || !provider.clientId || !clientSecret) {
        throw new Error(`OIDC provider ${id} requires issuer, clientId, and clientSecret`);
      }

      return {
        id,
        name: String(provider.name ?? "OIDC"),
        issuer: validateOidcIssuer(String(provider.issuer)),
        clientId: String(provider.clientId),
        clientSecret: String(clientSecret),
        scope: String(provider.scope ?? "openid email profile"),
        groupsClaim: String(provider.groupsClaim ?? "groups"),
        defaultRole: normalizeOidcRole(provider.defaultRole),
        allowSignup: provider.allowSignup === undefined ? true : provider.allowSignup === true,
        allowEmailAccountLinking: provider.allowEmailAccountLinking === true,
        requireEmailVerified: provider.requireEmailVerified === undefined ? false : provider.requireEmailVerified === true,
        adminEmails: new Set(normalizeAdminEmails(provider.adminEmails)),
        source: "env",
      };
    });
  }

  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    return [];
  }

  return [{
    id: normalizeOidcProviderId(process.env.OIDC_PROVIDER_ID ?? "oidc"),
    name: process.env.OIDC_PROVIDER_NAME ?? "OIDC",
    issuer: validateOidcIssuer(process.env.OIDC_ISSUER),
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    scope: process.env.OIDC_SCOPE ?? "openid email profile",
    groupsClaim: process.env.OIDC_GROUPS_CLAIM ?? "groups",
    defaultRole: normalizeOidcRole(process.env.OIDC_DEFAULT_ROLE),
    allowSignup: parseBoolean(process.env.OIDC_ALLOW_SIGNUP, true),
    allowEmailAccountLinking: parseBoolean(process.env.OIDC_ALLOW_EMAIL_ACCOUNT_LINKING, false),
    requireEmailVerified: parseBoolean(process.env.OIDC_REQUIRE_EMAIL_VERIFIED, false),
    adminEmails: new Set(parseCsv(process.env.OIDC_ADMIN_EMAILS).map((email) => email.toLowerCase())),
    source: "env",
  }];
}

function mapDatabaseProvider(provider: OidcProviderConnection): OidcProviderConfig {
  return {
    id: provider.providerId,
    name: provider.name,
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: decryptSecret(provider.encryptedClientSecret),
    scope: provider.scope,
    groupsClaim: provider.groupsClaim,
    defaultRole: normalizeOidcRole(provider.defaultRole),
    allowSignup: provider.allowSignup,
    allowEmailAccountLinking: provider.allowEmailAccountLinking,
    requireEmailVerified: provider.requireEmailVerified,
    adminEmails: new Set(normalizeAdminEmails(provider.adminEmails)),
    source: "database",
  };
}

function isMissingOidcTableError(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: string }).code === "P2021" || (error as { code?: string }).code === "P2022");
}

export function getEnvOidcProviderConfigs() {
  return readEnvOidcProviderConfigs();
}

export function getReservedEnvOidcProviderIds() {
  return new Set(getEnvOidcProviderConfigs().map((provider) => provider.id));
}

export async function getDatabaseOidcProviderConfigs() {
  try {
    const providers = await prisma.oidcProviderConnection.findMany({
      where: { isEnabled: true },
      orderBy: { name: "asc" },
    });
    return providers.map(mapDatabaseProvider);
  } catch (error) {
    if (isMissingOidcTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function getOidcProviderConfigs() {
  const envProviders = getEnvOidcProviderConfigs();
  const envIds = new Set(envProviders.map((provider) => provider.id));
  const databaseProviders = (await getDatabaseOidcProviderConfigs())
    .filter((provider) => !envIds.has(provider.id));

  return [...envProviders, ...databaseProviders];
}

export async function getOidcLoginProviders(): Promise<OidcProviderSummary[]> {
  return (await getOidcProviderConfigs()).map((provider) => ({
    id: provider.id,
    name: provider.name,
    source: provider.source,
  }));
}

export function serializeOidcProvider(provider: OidcProviderConnection) {
  return {
    id: provider.id,
    providerId: provider.providerId,
    name: provider.name,
    issuer: provider.issuer,
    clientId: provider.clientId,
    scope: provider.scope,
    groupsClaim: provider.groupsClaim,
    defaultRole: normalizeOidcRole(provider.defaultRole),
    allowSignup: provider.allowSignup,
    allowEmailAccountLinking: provider.allowEmailAccountLinking,
    requireEmailVerified: provider.requireEmailVerified,
    adminEmails: normalizeAdminEmails(provider.adminEmails),
    isEnabled: provider.isEnabled,
    hasClientSecret: Boolean(provider.encryptedClientSecret),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function encryptOidcClientSecret(secret: string) {
  return encryptSecret(secret);
}

export function oidcProviderWriteData(input: {
  providerId: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  groupsClaim: string;
  defaultRole: "admin" | "member";
  allowSignup: boolean;
  allowEmailAccountLinking: boolean;
  requireEmailVerified: boolean;
  adminEmails: string[];
  isEnabled: boolean;
}) {
  const data: Prisma.OidcProviderConnectionUncheckedCreateInput = {
    providerId: normalizeOidcProviderId(input.providerId),
    name: input.name.trim(),
    issuer: validateOidcIssuer(input.issuer.trim()),
    clientId: input.clientId.trim(),
    encryptedClientSecret: input.clientSecret ? encryptOidcClientSecret(input.clientSecret) : "",
    scope: input.scope.trim() || "openid email profile",
    groupsClaim: input.groupsClaim.trim() || "groups",
    defaultRole: input.defaultRole,
    allowSignup: input.allowSignup,
    allowEmailAccountLinking: input.allowEmailAccountLinking,
    requireEmailVerified: input.requireEmailVerified,
    adminEmails: normalizeAdminEmails(input.adminEmails) as Prisma.InputJsonValue,
    isEnabled: input.isEnabled,
  };

  return data;
}
