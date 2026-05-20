import type { StorageSettings } from "@prisma/client";

import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";
import { prisma } from "@/lib/prisma";

export const STORAGE_SETTINGS_ID = "default";
const DEFAULT_S3_REGION = "us-east-1";

export type StorageProviderName = "local" | "s3";
export type StorageSettingsSource = "default" | "environment" | "database";

export interface LocalStorageConfig {
  provider: "local";
  source: StorageSettingsSource;
}

export interface S3StorageConfig {
  provider: "s3";
  source: StorageSettingsSource;
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  forcePathStyle: boolean;
  prefix?: string;
}

export type EffectiveStorageConfig = LocalStorageConfig | S3StorageConfig;

export interface SerializedStorageConfig {
  provider: StorageProviderName;
  source: StorageSettingsSource;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  s3AccessKeyId: string | null;
  s3ForcePathStyle: boolean;
  s3Prefix: string | null;
  hasS3SecretAccessKey: boolean;
  hasS3SessionToken: boolean;
}

function cleanOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseBoolean(value: string | undefined, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeStorageProvider(value: string | null | undefined): StorageProviderName {
  const provider = cleanOptionalString(value)?.toLowerCase();
  if (!provider) return "local";
  if (provider === "local" || provider === "s3") return provider;
  throw new Error("Storage provider must be local or s3");
}

export function normalizeS3Prefix(value: string | null | undefined) {
  const trimmed = cleanOptionalString(value);
  if (!trimmed) return null;
  return trimmed.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/") || null;
}

export function normalizeS3Endpoint(value: string | null | undefined) {
  const trimmed = cleanOptionalString(value);
  if (!trimmed) return null;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("S3 endpoint must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeS3Bucket(value: string | null | undefined) {
  const bucket = cleanOptionalString(value);
  if (!bucket) {
    throw new Error("S3 bucket is required when S3 storage is enabled");
  }
  if (bucket.length > 255) {
    throw new Error("S3 bucket is too long");
  }
  return bucket;
}

function serializeConfig(config: EffectiveStorageConfig): SerializedStorageConfig {
  if (config.provider === "local") {
    return {
      provider: "local",
      source: config.source,
      s3Bucket: null,
      s3Region: null,
      s3Endpoint: null,
      s3AccessKeyId: null,
      s3ForcePathStyle: false,
      s3Prefix: null,
      hasS3SecretAccessKey: false,
      hasS3SessionToken: false,
    };
  }

  return {
    provider: "s3",
    source: config.source,
    s3Bucket: config.bucket,
    s3Region: config.region,
    s3Endpoint: config.endpoint ?? null,
    s3AccessKeyId: config.accessKeyId ?? null,
    s3ForcePathStyle: config.forcePathStyle,
    s3Prefix: config.prefix ?? null,
    hasS3SecretAccessKey: Boolean(config.secretAccessKey),
    hasS3SessionToken: Boolean(config.sessionToken),
  };
}

function envHasStorageConfig() {
  return Boolean(
    process.env.STORAGE_PROVIDER ||
    process.env.STORAGE_S3_BUCKET ||
    process.env.STORAGE_S3_REGION ||
    process.env.STORAGE_S3_ENDPOINT ||
    process.env.STORAGE_S3_ACCESS_KEY_ID ||
    process.env.STORAGE_S3_SECRET_ACCESS_KEY ||
    process.env.STORAGE_S3_SESSION_TOKEN ||
    process.env.STORAGE_S3_FORCE_PATH_STYLE ||
    process.env.STORAGE_S3_PREFIX
  );
}

export function getEnvStorageSettings(): EffectiveStorageConfig | null {
  if (!envHasStorageConfig()) {
    return null;
  }

  const provider = normalizeStorageProvider(
    process.env.STORAGE_PROVIDER ?? (process.env.STORAGE_S3_BUCKET ? "s3" : "local")
  );

  if (provider === "local") {
    return { provider: "local", source: "environment" };
  }

  const accessKeyId = cleanOptionalString(process.env.STORAGE_S3_ACCESS_KEY_ID);
  const secretAccessKey = cleanOptionalString(process.env.STORAGE_S3_SECRET_ACCESS_KEY);

  if (accessKeyId && !secretAccessKey) {
    throw new Error("STORAGE_S3_SECRET_ACCESS_KEY is required when STORAGE_S3_ACCESS_KEY_ID is set");
  }
  if (!accessKeyId && secretAccessKey) {
    throw new Error("STORAGE_S3_ACCESS_KEY_ID is required when STORAGE_S3_SECRET_ACCESS_KEY is set");
  }

  return {
    provider: "s3",
    source: "environment",
    bucket: normalizeS3Bucket(process.env.STORAGE_S3_BUCKET),
    region: cleanOptionalString(process.env.STORAGE_S3_REGION) ?? DEFAULT_S3_REGION,
    endpoint: normalizeS3Endpoint(process.env.STORAGE_S3_ENDPOINT) ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: secretAccessKey ?? undefined,
    sessionToken: cleanOptionalString(process.env.STORAGE_S3_SESSION_TOKEN) ?? undefined,
    forcePathStyle: parseBoolean(process.env.STORAGE_S3_FORCE_PATH_STYLE, false),
    prefix: normalizeS3Prefix(process.env.STORAGE_S3_PREFIX) ?? undefined,
  };
}

function isMissingStorageSettingsTableError(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (((error as { code?: string }).code === "P2021") || ((error as { code?: string }).code === "P2022"));
}

export async function getDatabaseStorageSettings() {
  try {
    return await prisma.storageSettings.findUnique({ where: { id: STORAGE_SETTINGS_ID } });
  } catch (error) {
    if (isMissingStorageSettingsTableError(error)) {
      return null;
    }
    throw error;
  }
}

export function mapDatabaseStorageSettings(settings: StorageSettings): EffectiveStorageConfig {
  if (settings.provider === "local") {
    return { provider: "local", source: "database" };
  }

  const accessKeyId = cleanOptionalString(settings.s3AccessKeyId);
  const encryptedSecret = cleanOptionalString(settings.encryptedS3SecretAccessKey);

  if (accessKeyId && !encryptedSecret) {
    throw new Error("Saved S3 access key is missing its secret key");
  }

  return {
    provider: "s3",
    source: "database",
    bucket: normalizeS3Bucket(settings.s3Bucket),
    region: cleanOptionalString(settings.s3Region) ?? DEFAULT_S3_REGION,
    endpoint: normalizeS3Endpoint(settings.s3Endpoint) ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: encryptedSecret ? decryptSecret(encryptedSecret) : undefined,
    sessionToken: settings.encryptedS3SessionToken ? decryptSecret(settings.encryptedS3SessionToken) : undefined,
    forcePathStyle: settings.s3ForcePathStyle,
    prefix: normalizeS3Prefix(settings.s3Prefix) ?? undefined,
  };
}

export async function getEffectiveStorageSettings(): Promise<EffectiveStorageConfig> {
  const databaseSettings = await getDatabaseStorageSettings();
  if (databaseSettings) {
    return mapDatabaseStorageSettings(databaseSettings);
  }

  return getEnvStorageSettings() ?? { provider: "local", source: "default" };
}

export async function getS3RuntimeStorageSettings() {
  const effective = await getEffectiveStorageSettings();
  if (effective.provider === "s3") {
    return effective;
  }

  const envSettings = getEnvStorageSettings();
  return envSettings?.provider === "s3" ? envSettings : null;
}

export function serializeStorageConfig(config: EffectiveStorageConfig | null) {
  return config ? serializeConfig(config) : null;
}

export function serializeDatabaseStorageSettings(settings: StorageSettings | null) {
  if (!settings) return null;
  return serializeConfig(mapDatabaseStorageSettings(settings));
}

export function encryptStorageSecret(secret: string) {
  return encryptSecret(secret);
}
