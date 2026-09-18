import { afterEach, expect, it, vi } from "vitest";
const { processJiraSync } = vi.hoisted(() => ({
  processJiraSync: vi.fn().mockResolvedValue({ processed: 2 }),
}));
vi.mock("@/server/services/jira/sync", () => ({ processJiraSync }));
import { POST } from "../route";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("rejects unauthenticated cron requests without running sync", async () => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  expect(
    (
      await POST(
        new Request("http://localhost/api/cron/sync-jira", { method: "POST" }),
      )
    ).status,
  ).toBe(401);
  expect(processJiraSync).not.toHaveBeenCalled();
});
it("requires a configured cron secret", async () => {
  vi.stubEnv("CRON_SECRET", "");
  expect(
    (
      await POST(
        new Request("http://localhost/api/cron/sync-jira", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
});
it("runs a bounded sync for authenticated cron calls", async () => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  const result = await POST(
    new Request("http://localhost/api/cron/sync-jira", {
      method: "POST",
      headers: { Authorization: "Bearer cron-secret" },
    }),
  );
  expect(await result.json()).toEqual({ processed: 2 });
  expect(processJiraSync).toHaveBeenCalledWith(expect.any(AbortSignal));
});
