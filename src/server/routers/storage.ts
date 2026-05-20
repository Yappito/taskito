import { z } from "zod";

import { adminProcedure, createTRPCRouter } from "@/server/trpc";
import {
  STORAGE_SETTINGS_ID,
  encryptStorageSecret,
  getDatabaseStorageSettings,
  getEffectiveStorageSettings,
  getEnvStorageSettings,
  normalizeS3Endpoint,
  normalizeS3Prefix,
  serializeDatabaseStorageSettings,
  serializeStorageConfig,
} from "@/server/services/storage-settings";

const storageSettingsInput = z.object({
  provider: z.enum(["local", "s3"]),
  s3Bucket: z.string().max(255).optional().nullable(),
  s3Region: z.string().max(100).optional().nullable(),
  s3Endpoint: z.string().max(500).optional().nullable(),
  s3AccessKeyId: z.string().max(300).optional().nullable(),
  s3SecretAccessKey: z.string().max(5000).optional().nullable(),
  s3SessionToken: z.string().max(5000).optional().nullable(),
  s3ForcePathStyle: z.boolean().default(false),
  s3Prefix: z.string().max(300).optional().nullable(),
  clearS3SessionToken: z.boolean().default(false),
});

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function getStoragePayload() {
  const [database, effective] = await Promise.all([
    getDatabaseStorageSettings(),
    getEffectiveStorageSettings(),
  ]);
  const environment = getEnvStorageSettings();

  return {
    effective: serializeStorageConfig(effective),
    database: serializeDatabaseStorageSettings(database),
    environment: serializeStorageConfig(environment),
  };
}

export const storageRouter = createTRPCRouter({
  get: adminProcedure.query(async () => getStoragePayload()),

  save: adminProcedure
    .input(storageSettingsInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.storageSettings.findUnique({ where: { id: STORAGE_SETTINGS_ID } });

      if (input.provider === "local") {
        await ctx.prisma.storageSettings.upsert({
          where: { id: STORAGE_SETTINGS_ID },
          create: {
            id: STORAGE_SETTINGS_ID,
            provider: "local",
          },
          update: {
            provider: "local",
            s3Bucket: null,
            s3Region: null,
            s3Endpoint: null,
            s3AccessKeyId: null,
            encryptedS3SecretAccessKey: null,
            encryptedS3SessionToken: null,
            s3ForcePathStyle: false,
            s3Prefix: null,
          },
        });
        return getStoragePayload();
      }

      const s3Bucket = clean(input.s3Bucket);
      if (!s3Bucket) {
        throw new Error("S3 bucket is required when S3 storage is enabled");
      }

      const s3AccessKeyId = clean(input.s3AccessKeyId);
      const s3SecretAccessKey = clean(input.s3SecretAccessKey);
      const s3SessionToken = clean(input.s3SessionToken);

      if (s3AccessKeyId && !s3SecretAccessKey && !existing?.encryptedS3SecretAccessKey) {
        throw new Error("S3 secret access key is required for this access key ID");
      }
      if (!s3AccessKeyId && (s3SecretAccessKey || s3SessionToken)) {
        throw new Error("S3 access key ID is required when access secrets are set");
      }

      await ctx.prisma.storageSettings.upsert({
        where: { id: STORAGE_SETTINGS_ID },
        create: {
          id: STORAGE_SETTINGS_ID,
          provider: "s3",
          s3Bucket,
          s3Region: clean(input.s3Region) ?? "us-east-1",
          s3Endpoint: normalizeS3Endpoint(input.s3Endpoint),
          s3AccessKeyId,
          encryptedS3SecretAccessKey: s3SecretAccessKey ? encryptStorageSecret(s3SecretAccessKey) : null,
          encryptedS3SessionToken: s3SessionToken ? encryptStorageSecret(s3SessionToken) : null,
          s3ForcePathStyle: input.s3ForcePathStyle,
          s3Prefix: normalizeS3Prefix(input.s3Prefix),
        },
        update: {
          provider: "s3",
          s3Bucket,
          s3Region: clean(input.s3Region) ?? "us-east-1",
          s3Endpoint: normalizeS3Endpoint(input.s3Endpoint),
          s3AccessKeyId,
          encryptedS3SecretAccessKey: s3AccessKeyId
            ? s3SecretAccessKey
              ? encryptStorageSecret(s3SecretAccessKey)
              : existing?.encryptedS3SecretAccessKey ?? null
            : null,
          encryptedS3SessionToken: input.clearS3SessionToken
            ? null
            : s3SessionToken
              ? encryptStorageSecret(s3SessionToken)
              : existing?.encryptedS3SessionToken ?? null,
          s3ForcePathStyle: input.s3ForcePathStyle,
          s3Prefix: normalizeS3Prefix(input.s3Prefix),
        },
      });

      return getStoragePayload();
    }),

  clearOverride: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.prisma.storageSettings.delete({ where: { id: STORAGE_SETTINGS_ID } }).catch(() => null);
    return getStoragePayload();
  }),
});
