import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { searchTasks } from "../services/task-search";
import { requireProjectAccess } from "../authz";
import { consumeRateLimit } from "@/lib/rate-limit";

/** Search router for project-scoped Prisma search */
export const searchRouter = createTRPCRouter({
  /** Full-text search scoped to a single active project */
  query: protectedProcedure
    .input(
      z.object({
        query: z.string().max(200),
        projectId: z.string().cuid(),
        statusIds: z.array(z.string().cuid()).optional(),
        priorities: z.array(z.enum(["none", "low", "medium", "high", "urgent"])) .optional(),
        tagNames: z.array(z.string().min(1).max(50)).max(20).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const rateLimit = consumeRateLimit("search", ctx.session.user.id, {
        maxAttempts: 30,
        windowMs: 60 * 1000,
      });

      if (!rateLimit.allowed) {
        throw new Error("Search rate limit exceeded");
      }

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      return searchTasks(ctx.prisma, {
        ...input,
      });
  }),
});
