import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  getEffectiveStorageSettings,
  getS3RuntimeStorageSettings,
  type S3StorageConfig,
  type StorageProviderName,
} from "@/server/services/storage-settings";

const UPLOAD_ROOT = path.join(process.cwd(), process.env.UPLOAD_DIR ?? "uploads");

export type StorageNamespace = "comment-attachments" | "profile-images";

export interface StoredFileInfo {
  storageProvider: StorageProviderName;
  storageBucket: string | null;
  storageKey: string;
  storagePath: string;
}

export interface StoredFileLocation {
  storageProvider?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  storagePath?: string | null;
}

function safeObjectFilename(filename: string) {
  const basename = path.basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return basename || `${randomUUID()}.bin`;
}

function assertSafeStorageKey(storageKey: string) {
  if (!storageKey || path.isAbsolute(storageKey) || storageKey.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error("Invalid storage key");
  }
}

function getLocalObjectPath(storageKey: string) {
  assertSafeStorageKey(storageKey);
  return path.join(UPLOAD_ROOT, storageKey);
}

function buildStorageKey(namespace: StorageNamespace, filename: string, prefix?: string) {
  const safeFilename = safeObjectFilename(filename);
  return [prefix, namespace, safeFilename].filter(Boolean).join("/");
}

function parseS3StoragePath(storagePath: string | null | undefined) {
  if (!storagePath?.startsWith("s3://")) {
    return null;
  }

  const withoutScheme = storagePath.slice("s3://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) {
    return null;
  }

  return {
    bucket: withoutScheme.slice(0, slashIndex),
    key: withoutScheme.slice(slashIndex + 1),
  };
}

function createS3Client(config: S3StorageConfig) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.accessKeyId && config.secretAccessKey
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          sessionToken: config.sessionToken,
        }
      : undefined,
  });
}

async function s3BodyToBuffer(body: unknown) {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }

  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable.transformToByteArray === "function") {
    return Buffer.from(await transformable.transformToByteArray());
  }

  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported S3 response body");
}

export async function storeFile(
  namespace: StorageNamespace,
  filename: string,
  buffer: Buffer,
  contentType: string
): Promise<StoredFileInfo> {
  const config = await getEffectiveStorageSettings();

  if (config.provider === "s3") {
    const storageKey = buildStorageKey(namespace, filename, config.prefix);
    const client = createS3Client(config);
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType,
    }));

    return {
      storageProvider: "s3",
      storageBucket: config.bucket,
      storageKey,
      storagePath: `s3://${config.bucket}/${storageKey}`,
    };
  }

  const storageKey = buildStorageKey(namespace, filename);
  const storagePath = getLocalObjectPath(storageKey);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await writeFile(storagePath, buffer);

  return {
    storageProvider: "local",
    storageBucket: null,
    storageKey,
    storagePath,
  };
}

export async function readStoredFile(location: StoredFileLocation) {
  const parsedS3Path = parseS3StoragePath(location.storagePath);
  const provider = location.storageProvider ?? (parsedS3Path ? "s3" : "local");

  if (provider === "s3") {
    const config = await getS3RuntimeStorageSettings();
    if (!config) {
      throw new Error("S3 storage is not configured");
    }

    const bucket = location.storageBucket ?? parsedS3Path?.bucket ?? config.bucket;
    const key = location.storageKey ?? parsedS3Path?.key;
    if (!key) {
      throw new Error("Stored S3 object key is missing");
    }

    const response = await createS3Client(config).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return s3BodyToBuffer(response.Body);
  }

  if (location.storagePath && !location.storagePath.startsWith("s3://")) {
    return readFile(location.storagePath);
  }

  if (!location.storageKey) {
    throw new Error("Stored local file key is missing");
  }

  return readFile(getLocalObjectPath(location.storageKey));
}

export async function removeStoredFile(location: StoredFileLocation) {
  const parsedS3Path = parseS3StoragePath(location.storagePath);
  const provider = location.storageProvider ?? (parsedS3Path ? "s3" : "local");

  if (provider === "s3") {
    const config = await getS3RuntimeStorageSettings();
    if (!config) {
      return;
    }

    const bucket = location.storageBucket ?? parsedS3Path?.bucket ?? config.bucket;
    const key = location.storageKey ?? parsedS3Path?.key;
    if (!key) {
      return;
    }

    await createS3Client(config).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }

  if (location.storagePath && !location.storagePath.startsWith("s3://")) {
    await rm(location.storagePath, { force: true });
    return;
  }

  if (location.storageKey) {
    await rm(getLocalObjectPath(location.storageKey), { force: true });
  }
}
