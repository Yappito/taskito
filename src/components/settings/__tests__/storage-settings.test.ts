import { describe, it, expect } from "vitest";
import { emptyStorageSettingsForm, storageConfigToForm, describeStorageConfig, type StorageConfigSummary } from "../storage-settings";

function config(overrides: Partial<StorageConfigSummary>): StorageConfigSummary {
  return {
    provider: "s3",
    source: "database",
    s3Bucket: "bucket",
    s3Region: "eu-west-1",
    s3Endpoint: null,
    s3AccessKeyId: "AKIA",
    s3ForcePathStyle: false,
    s3Prefix: null,
    hasS3SecretAccessKey: true,
    hasS3SessionToken: false,
    ...overrides,
  };
}

describe("storageConfigToForm", () => {
  it("returns the empty form for null config", () => {
    expect(storageConfigToForm(null)).toEqual(emptyStorageSettingsForm);
    expect(emptyStorageSettingsForm.provider).toBe("local");
  });

  it("maps an s3 config and strips write-only secrets", () => {
    const form = storageConfigToForm(config({}));
    expect(form).toEqual({
      provider: "s3",
      s3Bucket: "bucket",
      s3Region: "eu-west-1",
      s3Endpoint: "",
      s3AccessKeyId: "AKIA",
      s3SecretAccessKey: "",
      s3SessionToken: "",
      s3ForcePathStyle: false,
      s3Prefix: "",
      clearS3SessionToken: false,
    });
  });

  it("falls back to defaults for missing optional values", () => {
    const form = storageConfigToForm(config({ s3Region: null, s3AccessKeyId: null, s3Bucket: null }));
    expect(form.s3Region).toBe("us-east-1");
    expect(form.s3AccessKeyId).toBe("");
    expect(form.s3Bucket).toBe("");
  });

  it("maps a local config", () => {
    const form = storageConfigToForm(config({ provider: "local", source: "default" }));
    expect(form.provider).toBe("local");
  });
});

describe("describeStorageConfig", () => {
  it("describes a missing config", () => {
    expect(describeStorageConfig(null)).toBe("No environment storage override configured.");
  });

  it("describes local uploads with their source", () => {
    expect(describeStorageConfig(config({ provider: "local", source: "environment" }))).toBe(
      "Local uploads (environment)"
    );
  });

  it("describes an s3 bucket with prefix", () => {
    expect(describeStorageConfig(config({ s3Bucket: "taskito", s3Prefix: "prod" }))).toBe(
      "S3 bucket taskito / prod (database)"
    );
  });

  it("describes an s3 bucket without prefix", () => {
    expect(describeStorageConfig(config({ s3Bucket: "taskito", s3Prefix: null }))).toBe(
      "S3 bucket taskito (database)"
    );
  });
});
