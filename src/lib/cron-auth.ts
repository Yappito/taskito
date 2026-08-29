import { timingSafeEqual } from "node:crypto";

/**
 * Authorization header / secret comparison for the external cron endpoints.
 *
 * - Parses the `Bearer <token>` header (any other scheme parses to null).
 * - Compares with `crypto.timingSafeEqual` on equal-length buffers and rejects
 *   on length mismatch, so token validity does not hinge on an early-exit
 *   string compare (L12).
 */
export function parseBearerAuthorization(header: string | null): string | null {
  const match = /^Bearer[ ]+(.+)[ \r\t]*$/.exec(header ?? "");
  return match ? match[1] : null;
}

export function cronSecretEquals(provided: string | null, configuredSecret: string): boolean {
  if (!provided) {
    return false;
  }
  const providedBuffer = Buffer.from(provided, "utf8");
  const configuredBuffer = Buffer.from(configuredSecret, "utf8");
  if (providedBuffer.length !== configuredBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, configuredBuffer);
}