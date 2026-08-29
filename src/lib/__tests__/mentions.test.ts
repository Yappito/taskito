import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// The real `resolveMentionedUserIds` is imported below; its only runtime
// dependency is the Prisma singleton, which is mocked here so no database is
// touched.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { resolveMentionedUserIds } from "@/server/services/notifications";
import type { MentionPerson } from "@/lib/mentions";
import {
  filterMentionCandidates,
  findActiveMention,
  insertMention,
  mentionLabelFor,
  mentionTokenFor,
  mentionTokensFor,
} from "@/lib/mentions";

const findMany = prisma.user.findMany as unknown as Mock;

const PEOPLE: Array<{ id: string; email: string; name: string | null }> = [
  { id: "u-ada", email: "ada@taskito.local", name: "Ada Lovelace" },
  { id: "u-grace", email: "grace.hopper@example.com", name: "Grace Hopper" },
  // `+` is not part of the server token charset, so the resolvable token must
  // come from the name instead.
  { id: "u-kim", email: "kim+placeholder@example.com", name: "Kim Plus" },
  { id: "u-solo", email: "solo@taskito.local", name: null },
];

const asMentionPerson = (person: (typeof PEOPLE)[number]): MentionPerson => person;

function mockProjectPeople() {
  findMany.mockResolvedValue(
    PEOPLE.map((person) => ({ id: person.id, email: person.email, name: person.name }))
  );
}

describe("mention token format", () => {
  it("uses @ + email local-part when it fits the server token charset", () => {
    expect(mentionTokenFor(asMentionPerson(PEOPLE[0]))).toBe("@ada");
    expect(mentionTokenFor(asMentionPerson(PEOPLE[1]))).toBe("@grace.hopper");
    expect(mentionTokenFor(asMentionPerson(PEOPLE[3]))).toBe("@solo");
  });

  it("falls back to the hyphenated name when the local-part is not a valid token", () => {
    expect(mentionTokenFor(asMentionPerson(PEOPLE[2]))).toBe("@kim-plus");
  });

  it("always produces tokens matching the server-side charset [a-zA-Z0-9._-]+", () => {
    for (const person of PEOPLE) {
      const token = mentionTokenFor(asMentionPerson(person));
      expect(token).toMatch(/^@[a-zA-Z0-9._-]+$/);
    }
  });

  it("normalises names with whitespace runs to single hyphens", () => {
    expect(
      mentionTokenFor({ id: "u", email: "x+x@example.com", name: "  Ada   van   Der   Berg " })
    ).toBe("@ada-van-der-berg");
  });

  it("lists every token the server resolver would map back to the person", () => {
    expect(mentionTokensFor(asMentionPerson(PEOPLE[0]))).toEqual(["ada", "ada-lovelace"]);
    expect(mentionTokensFor(asMentionPerson(PEOPLE[3]))).toEqual(["solo"]);
  });
});

describe("findActiveMention", () => {
  it("detects a fresh trigger at the start of text", () => {
    expect(findActiveMention("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("detects an @ query after whitespace", () => {
    expect(findActiveMention("hi @ada", 7)).toEqual({ query: "ada", start: 3, end: 7 });
  });

  it("keeps the query empty right after the @", () => {
    expect(findActiveMention("hi @", 4)).toEqual({ query: "", start: 3, end: 4 });
  });

  it("ignores the domain part of typed email addresses", () => {
    expect(findActiveMention("ada@taskito.local", 17)).toBeNull();
  });

  it("stops at whitespace within the query", () => {
    expect(findActiveMention("@ada lo", 7)).toBeNull();
  });

  it("caps the query length", () => {
    expect(findActiveMention(`@${"a".repeat(65)}`, 66)).toBeNull();
    expect(findActiveMention(`@${"a".repeat(64)}`, 65)).not.toBeNull();
  });

  it("clamps the caret and never matches without a trigger", () => {
    expect(findActiveMention("hello", 0)).toBeNull();
    expect(findActiveMention("hello", 3)).toBeNull();
    expect(findActiveMention("hello", 999)).toBeNull();
  });
});

describe("insertMention", () => {
  it("replaces the active query with the token plus a trailing space", () => {
    // Caret after a partial query `@ad`: the typed query is replaced by the
    // canonical token (email local-part) plus a single space.
    const replaced = insertMention("ping @ad rest", 8, asMentionPerson(PEOPLE[0]));
    expect(replaced.text).toBe("ping @ada  rest");
    expect(replaced.caret).toBe("ping @ada ".length);

    // Inserting mid-query (caret 8 in `@ada`) only consumes `@ad`.
    const partial = insertMention("ping @ada rest", 8, asMentionPerson(PEOPLE[0]));
    expect(partial.text).toBe("ping @ada a rest");
  });

  it("inserts at the caret when no mention is active", () => {
    const result = insertMention("hello world", 5, asMentionPerson(PEOPLE[0]));
    expect(result.text).toBe("hello@ada  world");
    expect(result.caret).toBe("hello@ada ".length);
  });

  it("appends a space after the token at the end of the text", () => {
    const result = insertMention("", 0, asMentionPerson(PEOPLE[3]));
    expect(result.text).toBe("@solo ");
    expect(result.caret).toBe(6);
  });
});

describe("filterMentionCandidates", () => {
  const people = PEOPLE.map(asMentionPerson);

  it("returns everyone for an empty query", () => {
    expect(filterMentionCandidates(people, "")).toHaveLength(PEOPLE.length);
    expect(filterMentionCandidates(people, "@")).toHaveLength(PEOPLE.length);
  });

  it("filters case-insensitively by label, name and email", () => {
    expect(filterMentionCandidates(people, "ada").map((person) => person.id)).toEqual(["u-ada"]);
    expect(filterMentionCandidates(people, "LOV").map((person) => person.id)).toEqual(["u-ada"]);
    expect(filterMentionCandidates(people, "hopper").map((person) => person.id)).toEqual(["u-grace"]);
    expect(filterMentionCandidates(people, "solo@").map((person) => person.id)).toEqual(["u-solo"]);
  });

  it("returns nothing when nobody matches", () => {
    expect(filterMentionCandidates(people, "zzz")).toEqual([]);
  });
});

describe("mentionLabelFor", () => {
  it("prefers the name and falls back to the email", () => {
    expect(mentionLabelFor(asMentionPerson(PEOPLE[0]))).toBe("Ada Lovelace");
    expect(mentionLabelFor(asMentionPerson(PEOPLE[3]))).toBe("solo@taskito.local");
  });
});

describe("integration: token format round-trips through resolveMentionedUserIds", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("resolves the token produced by mentionTokenFor back to the person", async () => {
    mockProjectPeople();

    for (const person of PEOPLE) {
      const token = mentionTokenFor(asMentionPerson(person));
      const matched = await resolveMentionedUserIds("project-1", `please review ${token}`);
      expect(matched, `token ${token} for ${person.id}`).toContain(person.id);
    }
  });

  it("resolves tokens case-insensitively and inside longer text", async () => {
    mockProjectPeople();

    const token = mentionTokenFor(asMentionPerson(PEOPLE[1])).toUpperCase();
    const matched = await resolveMentionedUserIds("project-1", `FYI ${token}! Thanks`);
    expect(matched).toEqual(["u-grace"]);
  });

  it("does not resolve a prefix that is only a prefix of the token", async () => {
    mockProjectPeople();

    const matched = await resolveMentionedUserIds("project-1", "calling @ad now");
    expect(matched).not.toContain("u-ada");
  });

  it("resolves a comment body built via insertMention exactly like the UI produces", async () => {
    mockProjectPeople();

    // Simulate the full UI path: insert one mention via insertMention, then
    // resolve the resulting comment body the way comment-service does.
    let text = "";
    let caret = 0;
    for (const person of [PEOPLE[0], PEOPLE[2]]) {
      const inserted = insertMention(text, caret, asMentionPerson(person));
      text = inserted.text;
      caret = inserted.caret;
    }
    const matched = await resolveMentionedUserIds("project-1", text);
    expect(matched).toEqual(["u-ada", "u-kim"]);
    expect(text).toBe("@ada @kim-plus ");
  });
});