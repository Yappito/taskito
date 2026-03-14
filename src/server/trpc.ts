import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requireGlobalAdmin } from "@/server/authz";

/** Context available to all tRPC procedures */
export interface TRPCContext {
  session: Session | null;
  prisma: typeof prisma;
}

/** Creates the tRPC context for each request */
export async function createTRPCContext(opts: {
  headers: Headers;
  session: Session | null;
}): Promise<TRPCContext> {
  return {
    session: opts.session,
    prisma,
  };
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

/** Create a tRPC router */
export const createTRPCRouter = t.router;

/** Create a caller factory for server-side calls */
export const createCallerFactory = t.createCallerFactory;

/** Public (unauthenticated) procedure */
export const publicProcedure = t.procedure;

/** Protected (authenticated) procedure — requires valid session */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

/** Protected procedure restricted to global administrators. */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await requireGlobalAdmin(ctx.prisma, ctx.session.user.id);
  return next();
});
