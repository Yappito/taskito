import { describe, expect, it } from "vitest";

import { extractAiProposals, stripAiProposalBlock } from "@/server/services/ai/presenter";

describe("ai presenter", () => {
  it("extracts proposals from a proposal fence", () => {
    const content = 'Text before\n```proposal\n[{"actionType":"addComment","title":"Add note","summary":"Adds context.","payload":{"taskId":"clxtask0000000000000000000","content":"hello"}}]\n```\nText after';
    expect(extractAiProposals(content)).toHaveLength(1);
    expect(stripAiProposalBlock(content)).toBe("Text before\n\nText after");
  });

  it("extracts proposals from a json fence fallback", () => {
    const content = '```json\n[{"actionType":"addComment","title":"Add note","summary":"Adds context.","payload":{"taskId":"clxtask0000000000000000000","content":"hello"}}]\n```';
    expect(extractAiProposals(content)).toHaveLength(1);
    expect(stripAiProposalBlock(content)).toBe("");
  });
});
