/**
 * Strict single-mailbox address validation and display-name header encoding.
 *
 * Why this exists: `User.email` and operator-provided addresses (SMTP_FROM)
 * flow into `MAIL FROM:<…>` / `RCPT TO:<…>` envelope lines and the `To:` /
 * `From:` MIME headers. A permissive parser lets values like
 * `victim@example.com>\r\nRCPT TO:<attacker@example.com` smuggle extra SMTP
 * commands and header lines into the message. Everything that reaches the
 * wire therefore passes through `assertValidMailbox`, which only accepts a
 * strict addr-spec (RFC 5322 dot-atom local part + domain labels) and rejects
 * CR/LF, other control characters, whitespace, `<`, `>`, `,`, `;`, `"` and
 * multiple addresses *before* any socket is opened.
 *
 * Error messages include only the field name and reason — never the raw
 * value — so a hostile address cannot inject log lines either.
 */

/** Typed, non-retrying error for rejected mailbox strings. */
export class InvalidEmailAddressError extends Error {
  constructor(message: string) {
    super(`[email] ${message}`);
    this.name = "InvalidEmailAddressError";
  }
}

/** RFC 5322 `atext` characters (local-part atoms and dot-atoms). */
export const ATEXT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-/=?^_`{|}~";

// `-` must be escaped when the atext set is embedded into a character class
// (otherwise `+-/` silently becomes a range that includes `,` and `.`).
const ATEXT_CLASS = ATEXT_CHARS.replace("-", "\\-");
const DOT_ATOM = new RegExp(`^[${ATEXT_CLASS}]+(?:\\.[${ATEXT_CLASS}]+)*$`);
// The full domain is capped below. Keep the syntax check separate from its
// length check so the security boundary remains the allowed character set and
// separators, rather than an arbitrary per-label truncation.
const DOMAIN_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export interface ParsedMailbox {
  address: string;
  name?: string;
}

/**
 * Split "Display Name <addr@host>" into its name and address parts (or treat
 * the whole string as a bare address). Splitting is intentionally separate
 * from validation: every consumer of the wire must still run
 * `assertValidMailbox`.
 */
export function parseEmailAddress(value: string): ParsedMailbox {
  const raw = value;
  // The display-name form only counts when the name part contains no angle
  // brackets: otherwise strings like `victim@example.com>\r\nRCPT TO:<a@b.c>`
  // could be "split" into a poisoned name plus a clean-looking address.
  const match = raw.match(/^([^<>]*?)[ \t]*<([^<>]+)>[ \t]*$/);
  if (!match) {
    return { address: raw };
  }
  return { address: match[2], name: nameOrUndefined(match[1]) };
}

function nameOrUndefined(name: string): string | undefined {
  const cleaned = name.trim().replace(/^"(.*)"$/, "$1").trim();
  return cleaned ? cleaned : undefined;
}

function mailboxReason(address: string): string | null {
  if (address.length === 0) return "address is empty";
  if (address.length > 254) return "address is too long";
  if (/[\r\n]/.test(address)) return "CR/LF characters are not allowed";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(address)) return "control characters are not allowed";
  if (/\s/.test(address)) return "whitespace is not allowed";

  const atParts = address.split("@");
  if (atParts.length < 2) return "missing @ separator";
  if (atParts.length > 2) return "exactly one @ is allowed";

  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (local.length === 0) return "local part is empty";
  if (local.length > 64) return "local part exceeds 64 characters";
  if (!DOT_ATOM.test(local)) {
    return "local part must be an RFC 5322 dot-atom (no spaces, quotes, angle brackets, commas or other specials)";
  }

  if (domain.length === 0) return "domain part is empty";
  if (domain.length > 253) return "domain part exceeds 253 characters";
  if (domain.endsWith(".")) return "domain must not end with a trailing dot";
  if (!domain.includes(".")) {
    // Single-label domains (e.g. `user@localhost`) are allowed, but the label
    // must still be well-formed.
    return DOMAIN_LABEL.test(domain) ? null : "domain contains characters that are not letters, digits or hyphens";
  }
  for (const label of domain.split(".")) {
    if (label.length === 0) return "domain contains an empty label";
    if (!DOMAIN_LABEL.test(label)) {
      return "domain labels may only contain letters, digits and interior hyphens";
    }
  }
  return null;
}

/**
 * Validate the value as a single mailbox. Throws `InvalidEmailAddressError`
 * (with a message that is safe to log — the raw value is never echoed) when
 * the address is not a strict addr-spec, so callers can never turn it into
 * SMTP commands or extra MIME header lines. The validated address plus a
 * CRLF-stripped display name are returned for header rendering.
 */
export function assertValidMailbox(value: string, field = "email address"): ParsedMailbox {
  if (typeof value !== "string") {
    throw new InvalidEmailAddressError(`${field} must be a string`);
  }
  // Validate the original mailbox string too, not only the parsed addr-spec.
  // A display name may contain punctuation and is safely encoded later, but
  // line/control characters anywhere in this input are never acceptable.
  if (/[\r\n]/.test(value)) {
    throw new InvalidEmailAddressError(`${field} rejected: CR/LF characters are not allowed`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new InvalidEmailAddressError(`${field} rejected: control characters are not allowed`);
  }
  const parsed = parseEmailAddress(value);
  const reason = mailboxReason(parsed.address);
  if (reason) {
    throw new InvalidEmailAddressError(`${field} rejected: ${reason}`);
  }
  return { address: parsed.address, name: parsed.name };
}

/**
 * Header-safe rendering of a display name: strips CR/LF (and tabs), keeps
 * plain atext words as-is, wraps ASCII specials (`<`, `>`, `"` etc.) in an
 * escaped quoted-string, and RFC 2047 encodes anything non-ASCII. After this
 * a display name can never add header structure on its own.
 */
export function encodeDisplayName(name: string): string {
  const cleaned = name.replace(/[\r\n\t]+/g, " ").trim();
  if (!cleaned) return "";

  if (!/^[\x20-\x7e]*$/.test(cleaned)) {
    // Non-ASCII present: encode as RFC 2047 B words (no specials survive).
    return encodeHeaderValue(cleaned);
  }

  let needsQuoting = false;
  for (const ch of cleaned) {
    if (ch === " ") continue;
    if (!ATEXT_CHARS.includes(ch)) {
      needsQuoting = true;
      break;
    }
  }
  if (!needsQuoting) {
    return cleaned;
  }
  const escaped = cleaned.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

/**
 * RFC 2047 "B" encoding for header values, folded with CRLF + space. Kept in
 * this module (and re-exported by the smtp client) so address.ts has no
 * import cycle; encoding is the display-name safety net.
 */
export function encodeHeaderValue(value: string): string {
  const sanitized = value.replace(/[\r\n]+/g, " ").trim();
  if (!sanitized || /^[\x20-\x7e]*$/.test(sanitized)) {
    return sanitized;
  }

  const bytes = Buffer.from(sanitized, "utf8");
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 45, bytes.length);
    while (end > start + 1 && (bytes[end] & 0xc0) === 0x80) {
      end -= 1; // never split a UTF-8 continuation byte
    }
    words.push(`=?UTF-8?B?${bytes.subarray(start, end).toString("base64")}?=`);
    start = end;
  }
  return words.join("\r\n ");
}
