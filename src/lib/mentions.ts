/**
 * Mention helpers shared by the @mention autocomplete UI and the markdown
 * renderer.
 *
 * The canonical token format is defined by the server-side resolver
 * (`resolveMentionedUserIds` in src/server/services/notifications.ts): a token
 * is `@` followed by one or more `[a-zA-Z0-9._-]` characters, compared
 * case-insensitively against each project member's
 * - email local-part, or
 * - name lowercased with every whitespace run replaced by a single hyphen.
 *
 * Longest possible token wins on the server (the regex greedily consumes the
 * whole run after `@`), so tokens produced here must only ever contain
 * characters from that charset.
 */

export const MENTION_TRIGGER = "@";

/** Characters the server-side mention resolver accepts inside a token. */
const TOKEN_CHARSET = /^[a-zA-Z0-9._-]+$/;

/** Cap on how long an autocomplete query may get before it stops matching. */
export const MENTION_QUERY_MAX_LENGTH = 64;

export interface MentionPerson {
  id: string;
  name?: string | null;
  email: string;
  image?: string | null;
}

export interface ActiveMention {
  /** Query text typed so far, starting with `@` (the `@` itself excluded). */
  query: string;
  /** Index of the `@` character that opened the mention. */
  start: number;
  /** Caret position the mention was resolved against (end of the query). */
  end: number;
}

function isTokenChar(value: string) {
  return /[a-zA-Z0-9._-]/.test(value);
}

function safeTokenFrom(value: string | null | undefined) {
  if (!value || !TOKEN_CHARSET.test(value)) {
    return null;
  }
  return value;
}

export function mentionEmailToken(person: Pick<MentionPerson, "email">) {
  return person.email.split("@")[0]?.toLowerCase() ?? "";
}

export function mentionNameToken(person: Pick<MentionPerson, "name">) {
  return person.name?.trim().toLowerCase().replace(/\s+/g, "-") ?? "";
}

/**
 * Any token that the server-side mention resolver would map back to this
 * person (email local-part and/or hyphenated name), used for rendering
 * highlights.
 */
export function mentionTokensFor(person: MentionPerson): string[] {
  const tokens: string[] = [];
  const emailToken = safeTokenFrom(mentionEmailToken(person));
  if (emailToken) {
    tokens.push(emailToken);
  }
  const nameToken = safeTokenFrom(mentionNameToken(person));
  if (nameToken && nameToken !== emailToken) {
    tokens.push(nameToken);
  }
  return tokens;
}

/**
 * The canonical insertion token for a person: `@` + the email local-part when
 * it fits the server charset, otherwise the hyphenated name.
 */
export function mentionTokenFor(person: MentionPerson): string {
  const token =
    safeTokenFrom(mentionEmailToken(person)) ??
    safeTokenFrom(mentionNameToken(person)) ??
    // No resolvable token exists for this person (e.g. emoji-only names and a
    // local-part with characters the server regex cannot capture); keep a
    // deterministic best-effort token so the autocomplete still inserts
    // something valid-looking.
    "user";
  return `${MENTION_TRIGGER}${token}`;
}

export function mentionLabelFor(person: MentionPerson) {
  return person.name?.trim() || person.email;
}

/**
 * Detect an active @mention directly before the caret.
 *
 * Scanning walks back from `caret` over token characters only, so a query can
 * never contain whitespace or `@`. The mention only activates when the `@`
 * sits at a word boundary (start of text or preceded by a non-token char) —
 * this keeps typing the domain part of an email address (`ada@example.com`)
 * from popping the suggestion list.
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  const position = Math.min(Math.max(caret, 0), text.length);
  if (position === 0) {
    return null;
  }

  let index = position - 1;
  while (index >= 0 && position - 1 - index < MENTION_QUERY_MAX_LENGTH && isTokenChar(text[index]!)) {
    index -= 1;
  }

  if (index < 0 || text[index] !== MENTION_TRIGGER) {
    return null;
  }

  const at = index;
  if (at > 0 && isTokenChar(text[at - 1]!)) {
    // The `@` is glued to a preceding word (email/identifier style text).

    return null;
  }

  return { query: text.slice(at + 1, position), start: at, end: position };
}

/**
 * Insert a person's mention token (plus a trailing space) into `text`,
 * replacing the active query before `caret` when one exists.
 */
export function insertMention(
  text: string,
  caret: number,
  person: MentionPerson
): { text: string; caret: number } {
  const token = mentionTokenFor(person);
  const active = findActiveMention(text, caret);
  const start = active ? active.start : Math.min(Math.max(caret, 0), text.length);
  const end = active ? active.end : Math.min(Math.max(caret, 0), text.length);

  return {
    text: `${text.slice(0, start)}${token} ${text.slice(end)}`,
    caret: start + token.length + 1,
  };
}

/**
 * Filter project people for the autocomplete popover: case-insensitive
 * substring match against name, hyphenated name token and email.
 */
export function filterMentionCandidates(
  people: readonly MentionPerson[],
  query: string
): MentionPerson[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...people];
  }

  const matches = (candidate: string) => candidate.toLowerCase().includes(normalizedQuery);
  return people.filter(
    (person) =>
      matches(mentionLabelFor(person)) ||
      matches(mentionNameToken(person)) ||
      matches(person.email)
  );
}