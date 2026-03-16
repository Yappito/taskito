import { PrismaClient } from "@prisma/client";

const REQUIRED_DELEGATES = [
  "activityEvent",
  "commentAttachment",
  "customField",
  "notification",
  "taskWatcher",
] as const;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function hasCurrentPrismaShape(client: PrismaClient) {
  return REQUIRED_DELEGATES.every((delegate) => delegate in client);
}

function createPrismaClient() {
  return new PrismaClient();
}

const existingPrisma = globalForPrisma.prisma;

if (existingPrisma && !hasCurrentPrismaShape(existingPrisma)) {
  existingPrisma.$disconnect().catch(() => {
    // Ignore disconnect failures while replacing a stale hot-reloaded client.
  });
  globalForPrisma.prisma = undefined;
}

/** Singleton Prisma client — reused across hot reloads in development */
export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
