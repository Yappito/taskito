import { describe, expect, it } from "vitest";

import { buildAiSystemPrompt, extractAiProposals, stripAiProposalBlock } from "@/server/services/ai/presenter";

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

  it("returns no proposals for plain approval prose without a proposal block", () => {
    const content = "I have prepared a proposal to archive LAZLO-2 and create a new task. Please approve to proceed.";
    expect(extractAiProposals(content)).toEqual([]);
    expect(stripAiProposalBlock(content)).toBe(content);
  });

  it("explicitly requires a proposal block when asking for approval", () => {
    const prompt = buildAiSystemPrompt({
      projectName: "Taskito",
      mode: "approval",
      permissions: ["archive_task", "create_task"],
      currentDate: "2026-05-06T12:00:00.000Z",
    });

    expect(prompt).toMatch(/must include a fenced json block labeled proposal/i);
    expect(prompt).toMatch(/Do not ask for approval without including the proposal block/i);
  });
});
