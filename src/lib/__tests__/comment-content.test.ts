import { describe, expect, it } from "vitest";

import { getCommentBody } from "../comment-content";

describe("comment content helpers", () => {
  it("returns plain comment content unchanged when there are no attachments", () => {
    expect(getCommentBody("  Hello Taskito  ")).toBe("Hello Taskito");
  });

  it("strips legacy attachment references from the rendered comment body", () => {
    expect(
      getCommentBody("Please review this.\n\nAttachments:\n- screenshot.png\n- notes.txt", [
        { originalName: "screenshot.png" },
        { originalName: "notes.txt" },
      ])
    ).toBe("Please review this.");
  });

  it("returns an empty body for attachment-only legacy comments", () => {
    expect(
      getCommentBody("Attachments:\n- screenshot.png", [{ originalName: "screenshot.png" }])
    ).toBe("");
  });
});
