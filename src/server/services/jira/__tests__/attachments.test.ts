import { describe, expect, it } from "vitest";
import { normalizeJiraAttachment } from "../attachments";

const site = "https://team.atlassian.net";
// JSM AttachmentDTO: intentionally no id or top-level content property.
export const jsmAttachment = {
  filename: "private.txt",
  size: 3,
  mimeType: "text/plain",
  _links: {
    jiraRest: `${site}/rest/api/2/attachment/279743`,
    content: `${site}/attachment/279743/private.txt`,
  },
};

describe("Jira attachment contracts", () => {
  it("normalizes platform and JSM responses to the same stable ID", () => {
    expect(normalizeJiraAttachment(jsmAttachment, site)).toEqual({
      id: "279743",
      filename: "private.txt",
      size: 3,
      mimeType: "text/plain",
    });
    expect(
      normalizeJiraAttachment({ ...jsmAttachment, id: "279743" }, site).id,
    ).toBe("279743");
  });
  it.each([
    undefined,
    `${site}/rest/api/2/attachment/not-an-id`,
    `${site}/rest/api/2/attachment/279743/other`,
    `${site}/rest/api/2/attachment/279743?secret=token`,
    "https://elsewhere.atlassian.net/rest/api/2/attachment/279743",
    "https://user:password@team.atlassian.net/rest/api/2/attachment/279743",
  ])(
    "rejects missing or invalid identifiers before database access: %s",
    (jiraRest) => {
      expect(() =>
        normalizeJiraAttachment(
          { ...jsmAttachment, _links: { jiraRest } },
          site,
        ),
      ).toThrow("no valid attachment ID");
    },
  );
  it("rejects invalid metadata", () => {
    expect(() =>
      normalizeJiraAttachment({ ...jsmAttachment, size: -1 }, site),
    ).toThrow("invalid file metadata");
  });
});
