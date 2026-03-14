import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { auth } from "@/lib/auth";

const MAX_TRPC_CONTENT_LENGTH = 100_000;

/** tRPC HTTP handler for App Router */
async function handler(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("batch") === "1") {
    return Response.json({ error: "tRPC batching is disabled" }, { status: 400 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_TRPC_CONTENT_LENGTH) {
    return Response.json({ error: "Request body too large" }, { status: 413 });
  }

  const session = await auth();

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createTRPCContext({
        headers: req.headers,
        session,
      }),
    onError({ error, path }) {
      console.error(`❌ tRPC error on '${path ?? "<no-path>"}':`, error.message);
    },
  });
}

export { handler as GET, handler as POST };
