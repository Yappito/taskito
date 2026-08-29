// Next.js instrumentation hook: runs once per server process start.
//
// Starts the in-process scheduler (recurrence + due-date automation) only in the
// Node.js runtime — the Edge runtime cannot load Prisma — and never during
// `next build` (NEXT_PHASE=phase-production-build), where there is no database.
// startScheduler() itself is idempotent, so hot reloads cannot double-start it.

export async function register() {
  // The dynamic import MUST sit inside this `if` block: webpack prunes dead
  // branches of a DefinePlugin constant at parse time, so the edge compilation
  // never follows scheduler → routers → notifications → node:net/node:tls.
  // An early `return` before the import does NOT achieve that.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;

    try {
      const { startScheduler } = await import("@/server/services/scheduler");
      startScheduler();
    } catch (error) {
      console.error("[scheduler] failed to start:", error instanceof Error ? error.message : error);
    }
  }
}