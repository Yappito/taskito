import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { TRPCProvider } from "@/lib/trpc-client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { PwaRegister } from "@/components/pwa/pwa-register";
import { getAppearanceSettings } from "@/lib/themes";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Taskito",
  description: "Self-hosted task management with timeline-graph visualization",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#6366f1",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

/** Root layout wrapping all pages */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();
  const initialAppearance = session?.user?.id
    ? getAppearanceSettings((await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { settings: true },
      }))?.settings)
    : undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider initialAppearance={initialAppearance}>
          <TRPCProvider>{children}<PwaRegister /></TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
