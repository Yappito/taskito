import { NextResponse } from "next/server";
import { cronSecretEquals, parseBearerAuthorization } from "@/lib/cron-auth";
import { processJiraSync } from "@/server/services/jira/sync";
export async function POST(request: Request) {
  if (!process.env.CRON_SECRET)
    return NextResponse.json(
      { error: "Cron is not configured" },
      { status: 503 },
    );
  if (
    !cronSecretEquals(
      parseBearerAuthorization(request.headers.get("authorization")),
      process.env.CRON_SECRET,
    )
  )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(
    await processJiraSync(AbortSignal.timeout(5 * 60000)),
  );
}
