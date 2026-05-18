import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { processDueRecurrences } from "@/server/services/recurrence-processor";

export async function POST(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "Recurring-task cron is not configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${configuredSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processDueRecurrences(prisma, { limit: 100 });
  return NextResponse.json(result);
}
