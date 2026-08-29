import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startScheduler } = vi.hoisted(() => ({
  startScheduler: vi.fn(),
}));

vi.mock("@/server/services/scheduler", () => ({
  startScheduler,
}));

import { register } from "@/instrumentation";

const originalRuntime = process.env.NEXT_RUNTIME;
const originalPhase = process.env.NEXT_PHASE;

function restoreEnv() {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;

  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
}

describe("instrumentation register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("starts the scheduler in the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-runtime";

    await register();

    expect(startScheduler).toHaveBeenCalledTimes(1);
  });

  it("does not start outside the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.NEXT_PHASE = "phase-production-runtime";

    await register();

    expect(startScheduler).not.toHaveBeenCalled();
  });

  it("does not start during next build", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";

    await register();

    expect(startScheduler).not.toHaveBeenCalled();
  });

  it("swallows scheduler startup errors so the server still boots", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    startScheduler.mockImplementation(() => {
      throw new Error("scheduler failed to boot");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await register();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler]"), "scheduler failed to boot");
    } finally {
      errorSpy.mockRestore();
    }
  });
});