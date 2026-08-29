import { describe, it, expect } from "vitest";
import { deriveProjectNameFields, emptyProject, emptyProjectEdit } from "../project-management";

describe("deriveProjectNameFields", () => {
  it("slugifies the name and derives a short upper-case key", () => {
    expect(deriveProjectNameFields("Test Project")).toEqual({ slug: "test-project", key: "TESTP" });
  });

  it("strips unsupported characters", () => {
    const { slug, key } = deriveProjectNameFields("R&D: Team's 'Board'!");
    expect(slug).toBe("rd-teams-board");
    expect(key).toBe("RDTEA");
  });

  it("collapses repeated separators and limits slug length to 50", () => {
    const longName = "A".repeat(80);
    const { slug } = deriveProjectNameFields(`Multi   --  Space ${longName}`);
    expect(slug).not.toContain("--");
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.startsWith("multi-space")).toBe(true);
  });

  it("limits the key to 5 characters", () => {
    expect(deriveProjectNameFields("ABCDEFG").key).toBe("ABCDE");
  });
});

describe("empty project forms", () => {
  it("start blank", () => {
    expect(emptyProject).toEqual({ name: "", slug: "", key: "", description: "" });
    expect(emptyProjectEdit).toEqual({ name: "", description: "" });
  });
});
