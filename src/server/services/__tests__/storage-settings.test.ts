import { afterEach, describe, expect, it } from "vitest";

import { getEnvStorageSettings, normalizeS3Prefix } from "../storage-settings";

const STORAGE_ENV_KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_S3_BUCKET",
  "STORAGE_S3_REGION",
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "STORAGE_S3_SESSION_TOKEN",
  "STORAGE_S3_FORCE_PATH_STYLE",
  "STORAGE_S3_PREFIX",
] as const;

const originalEnv = Object.fromEntries(STORAGE_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<typeof STORAGE_ENV_KEYS[number], string | undefined>;

function resetStorageEnv() {
  for (const key of STORAGE_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("storage settings", () => {
  afterEach(() => {
    resetStorageEnv();
  });

  it("returns null when no storage environment variables are configured", () => {
    for (const key of STORAGE_ENV_KEYS) {
      delete process.env[key];
    }

    expect(getEnvStorageSettings()).toBeNull();
  });

  it("parses S3 environment configuration", () => {
    for (const key of STORAGE_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.STORAGE_PROVIDER = "s3";
    process.env.STORAGE_S3_BUCKET = "taskito-files";
    process.env.STORAGE_S3_REGION = "eu-central-1";
    process.env.STORAGE_S3_ENDPOINT = "https://minio.example.test/";
    process.env.STORAGE_S3_ACCESS_KEY_ID = "access-key";
    process.env.STORAGE_S3_SECRET_ACCESS_KEY = "secret-key";
    process.env.STORAGE_S3_FORCE_PATH_STYLE = "true";
    process.env.STORAGE_S3_PREFIX = "/taskito/prod/";

    expect(getEnvStorageSettings()).toMatchObject({
      provider: "s3",
      source: "environment",
      bucket: "taskito-files",
      region: "eu-central-1",
      endpoint: "https://minio.example.test",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      forcePathStyle: true,
      prefix: "taskito/prod",
    });
  });

  it("normalizes S3 object key prefixes", () => {
    expect(normalizeS3Prefix("/taskito//prod/")).toBe("taskito/prod");
    expect(normalizeS3Prefix("   ")).toBeNull();
  });
});
