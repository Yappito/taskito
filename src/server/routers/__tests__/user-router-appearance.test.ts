import { describe, expect, it } from "vitest";

import { createCallerFactory } from "@/server/trpc";
import { userRouter } from "@/server/routers/user";
import { createPrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(userRouter);

describe("user router appearance settings", () => {
  it("returns default appearance settings when none are stored", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member", disabledAt: null });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ settings: {} });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    await expect(caller.appearance()).resolves.toEqual({
      scheme: "system",
      lightThemeId: "horizon-light",
      darkThemeId: "midnight-neon-dark",
      customThemes: [],
    });
  });

  it("normalizes and persists appearance settings", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "member", disabledAt: null });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      settings: {
        aiPreferences: { sendOnEnter: true },
      },
    });
    prisma.user.update.mockResolvedValue({});

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "user-1", role: "member" } } as never,
    });

    const result = await caller.updateAppearance({
      scheme: "dark",
      lightThemeId: "paper-ink-light",
      darkThemeId: "custom-midnight",
      customThemes: [
        {
          id: "custom-midnight",
          name: "Custom Midnight",
          mode: "dark",
          palette: {
            background: "#0a0b10",
            backgroundElevated: "#11131a",
            backgroundMuted: "#191c26",
            surface: "#151925",
            border: "#2d3347",
            text: "#edf1ff",
            textSecondary: "#b0bbd7",
            textMuted: "#7580a3",
            accent: "#6f7cff",
            accentSecondary: "#3ed7ff",
            success: "#33d399",
            warning: "#fbbf24",
            danger: "#fb7185",
            appGradientFrom: "#23338f",
            appGradientTo: "#0f8eb9",
            headerGradientFrom: "#6f7cff",
            headerGradientTo: "#3ed7ff",
            spotlightGradientFrom: "#4658d5",
            spotlightGradientTo: "#0ea5e9",
          },
        },
      ],
    });

    expect(result).toEqual({
      scheme: "dark",
      lightThemeId: "paper-ink-light",
      darkThemeId: "custom-midnight",
      customThemes: [
        expect.objectContaining({
          id: "custom-midnight",
          name: "Custom Midnight",
          mode: "dark",
        }),
      ],
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        settings: expect.objectContaining({
          aiPreferences: { sendOnEnter: true },
          appearance: expect.objectContaining({
            scheme: "dark",
            lightThemeId: "paper-ink-light",
            darkThemeId: "custom-midnight",
          }),
        }),
      },
    });
  });
});
