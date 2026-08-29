import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { bearerSessionFromIdentity, resolveBearerToken } from "@/server/services/api-tokens";
import { getCurrentActor, requireGlobalAdmin } from "@/server/authz";

/** Context available to all tRPC procedures */
export interface TRPCContext {
  session: Session | null;
  prisma: typeof prisma;
}

/**
 * Creates the tRPC context for each request.
 *
 * Cookie sessions win; when none is present, a valid personal API token
 * (`Authorization: Bearer tk_…`) produces an equivalent session tagged with
 * `authMethod: "token"`. Individual procedures decide what token sessions may
 * do — see {@link cookieSessionProcedure}.
 */
export async function createTRPCContext(opts: {
  headers: Headers;
  session: Session | null;
}): Promise<TRPCContext> {
  let session = opts.session;
  if (!session?.user?.id) {
    const identity = await resolveBearerToken(prisma, opts.headers);
    if (identity) {
      session = bearerSessionFromIdentity(identity);
    }
  }

  return {
    session,
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
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  await getCurrentActor(ctx.prisma, ctx.session.user.id);
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

/**
 * Protected procedure restricted to browser cookie sessions.
 *
 * Personal API tokens are rejected: v1 tokens never manage account
 * credentials, tokens themselves, or other users. Note that adminProcedure is
 * built on this, so bearer tokens never grant admin — even for admin users.
 */
export const cookieSessionProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.session.authMethod === "token") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This action is not available with API token authentication. Sign in with your browser instead.",
    });
  }
  return next();
});

/** Protected procedure restricted to global administrators (cookie sessions only). */
export const adminProcedure = cookieSessionProcedure.use(async ({ ctx, next }) => {
  await requireGlobalAdmin(ctx.prisma, ctx.session.user.id);
  return next();
});
