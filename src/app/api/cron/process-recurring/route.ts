import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { cronSecretEquals, parseBearerAuthorization } from "@/lib/cron-auth";
import { processDueRecurrences } from "@/server/services/recurrence-processor";
import { withSchedulerLock } from "@/server/services/scheduler";

export async function POST(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "Recurring-task cron is not configured" }, { status: 503 });
  }

  // L12: constant-time comparison — parse the Bearer token and compare
  // equal-length buffers with crypto.timingSafeEqual.
  const providedToken = parseBearerAuthorization(request.headers.get("authorization"));
  if (!cronSecretEquals(providedToken, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // M8: run under the scheduler advisory lock so the external cron endpoint
  // never races the built-in tick (or other replicas) — when a tick holds the
  // lock this request skips instead of double-creating occurrences.
  const result = await withSchedulerLock(() => processDueRecurrences(prisma, { limit: 100 }));
  if (result === null) {
    return NextResponse.json({ skipped: true }, { status: 409 });
  }
  return NextResponse.json(result);
}