import { z } from "zod";
import { createTRPCRouter, adminProcedure, protectedProcedure } from "../trpc";
import { searchTasks, initMeiliSearch, bulkSyncTasks } from "../services/meilisearch";
import { getAccessibleProjectIds, requireProjectAccess } from "../authz";
import { consumeRateLimit } from "@/lib/rate-limit";

/** Search router for MeiliSearch-powered full-text search */
export const searchRouter = createTRPCRouter({
  /** Full-text search with faceted filtering */
  query: protectedProcedure
    .input(
      z.object({
        query: z.string().max(200),
        projectId: z.string().cuid().optional(),
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

      let projectIds: string[];
      if (input.projectId) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
        projectIds = [input.projectId];
      } else {
        projectIds = await getAccessibleProjectIds(ctx.prisma, ctx.session.user.id);
      }

      if (projectIds.length === 0) {
        return { hits: [], totalHits: 0, processingTimeMs: 0 };
      }

      return searchTasks({
        ...input,
        projectIds,
      });
    }),

  /** Initialize MeiliSearch index and bulk sync */
  sync: adminProcedure.mutation(async ({ ctx }) => {
    await initMeiliSearch();
    const count = await bulkSyncTasks(ctx.prisma);
    return { indexed: count };
  }),
});
