"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink, loggerLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { useState } from "react";
import superjson from "superjson";
import type { AppRouter } from "@/server/routers/_app";

/** tRPC React client */
export const trpc = createTRPCReact<AppRouter>();

/** Returns the base URL for tRPC requests */
function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

function shouldEnableTrpcLogger() {
  return process.env.NEXT_PUBLIC_TRPC_LOG_ERRORS === "true";
}

/** Provider component wrapping tRPC + TanStack Query */
export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        ...(shouldEnableTrpcLogger()
          ? [
              loggerLink({
                enabled: () => true,
              }),
            ]
          : []),
        httpLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
