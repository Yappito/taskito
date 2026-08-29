import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { auth } from "@/lib/auth";
import { normalizeAiPermissions } from "@/lib/ai-permissions";
import { AI_PERMISSION_PRESETS, AI_PERMISSION_VALUES } from "@/lib/ai-types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/server/authz";
import { buildAiAssistantTurnRequest, persistAiAssistantCompletion } from "@/server/services/ai/orchestrator";
import { streamWithAnthropicProvider } from "@/server/services/ai/provider-anthropic";
import { streamWithOpenAiCompatibleProvider } from "@/server/services/ai/provider-openai-compatible";

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function assertSameOrigin(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin) {
    throw new Error("Invalid request origin");
  }
  const referer = request.headers.get("referer");
  if (!origin && referer && new URL(referer).origin !== requestOrigin) {
    throw new Error("Invalid request referer");
  }
}

async function getEffectiveConversation(conversationId: string, userId: string) {
  const conversation = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
  await requireProjectAccess(prisma, userId, conversation.projectId);
  if (conversation.createdByUserId !== userId) {
    throw new Error("You do not have access to this conversation");
  }

  const provider = await prisma.aiProviderConnection.findUniqueOrThrow({ where: { id: conversation.providerId } });
  if (!provider.isEnabled) {
    throw new Error("Selected provider is disabled");
  }
  const policy = await prisma.aiProjectPolicy.findUnique({ where: { projectId: conversation.projectId } });
  const maxPermissions = normalizeAiPermissions(policy?.maxPermissions ?? AI_PERMISSION_VALUES);
  const grantedPermissions = normalizeAiPermissions(conversation.grantedPermissions ?? AI_PERMISSION_PRESETS.read_only)
    .filter((permission) => maxPermissions.includes(permission));

  return {
    ...conversation,
    grantedPermissions: grantedPermissions as unknown as Prisma.JsonValue,
  };
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    assertSameOrigin(request);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as { conversationId?: string; content?: string } | null;
  const conversationId = body?.conversationId;
  const content = body?.content?.trim();
  if (!conversationId || !content) {
    return NextResponse.json({ error: "conversationId and content are required" }, { status: 400 });
  }
  if (content.length > 10_000) {
    return NextResponse.json({ error: "Message is too long" }, { status: 400 });
  }

  const rateLimit = consumeRateLimit("ai-chat", session.user.id, {
    maxAttempts: 20,
    windowMs: 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "AI chat rate limit exceeded" }, { status: 429 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const conversation = await getEffectiveConversation(conversationId, session.user.id);
        await prisma.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: "user",
            content,
          },
        });
        await prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

        const turnRequest = await buildAiAssistantTurnRequest(prisma, {
          conversation,
          requestedByUserId: session.user.id,
        });
        controller.enqueue(encoder.encode(sse({ type: "started" })));

        const completion = turnRequest.provider.adapter === "anthropic"
          ? await streamWithAnthropicProvider(turnRequest.provider, turnRequest.syntheticMessages, turnRequest.tools, (delta) => {
              controller.enqueue(encoder.encode(sse({ type: "content", delta })));
            }, request.signal)
          : await streamWithOpenAiCompatibleProvider(turnRequest.provider, turnRequest.syntheticMessages, turnRequest.tools, (delta) => {
              controller.enqueue(encoder.encode(sse({ type: "content", delta })));
            }, request.signal);

        if (request.signal.aborted) {
          throw new Error("AI stream aborted");
        }

        const persisted = await persistAiAssistantCompletion(prisma, {
          conversation,
          requestedByUserId: session.user.id,
          completion,
          selectedTaskIds: turnRequest.selectedTaskIds,
        });

        controller.enqueue(encoder.encode(sse({
          type: "done",
          messageId: persisted.message.id,
          proposalIds: persisted.proposals.map((proposal) => proposal.id),
          truncated: completion.truncated,
        })));
      } catch (error) {
        controller.enqueue(encoder.encode(sse({
          type: "error",
          error: error instanceof Error ? error.message : "AI stream failed",
        })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
