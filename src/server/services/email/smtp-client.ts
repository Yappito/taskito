import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

import {
  assertValidMailbox,
  encodeDisplayName,
  encodeHeaderValue,
  InvalidEmailAddressError,
  parseEmailAddress,
} from "./address";

// Mailbox parsing/validation and RFC 2047 encoding live in address.ts;
// re-exported here for callers that only import the client.
export { encodeHeaderValue, parseEmailAddress, InvalidEmailAddressError } from "./address";

/**
 * Minimal SMTP client built on node:net / node:tls (no external mail packages).
 * Supports EHLO, STARTTLS (when offered), AUTH PLAIN / AUTH LOGIN,
 * MAIL FROM / RCPT TO / DATA with dot-stuffing, RFC 2047 encoded headers and a
 * text/plain + text/html multipart/alternative body.
 */

export interface OutgoingEmailMessage {
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  fromName?: string;
  tlsRejectUnauthorized: boolean;
  /** Explicit opt-in to sending credentials over a non-TLS connection. */
  allowInsecureAuth: boolean;
  /** Deadline for TCP connect + TLS handshakes (default 10000). */
  connectTimeoutMs?: number;
  /** Overall per-message deadline for the whole SMTP conversation (default 60000). */
  messageTimeoutMs?: number;
}

export interface SmtpSocketLike extends EventEmitter {
  write(chunk: string, cb?: (error?: Error | null) => void): boolean;
  end(cb?: () => void): void;
  destroy(): void;
}

export interface SmtpConnection {
  socket: SmtpSocketLike;
  upgrade(): Promise<SmtpSocketLike>;
  close(): void;
}

export type SmtpConnectionFactory = () => Promise<SmtpConnection>;

export interface SmtpSendOptions {
  config?: SmtpConfig | null;
  connectionFactory?: SmtpConnectionFactory;
  responseTimeoutMs?: number;
  connectTimeoutMs?: number;
  messageTimeoutMs?: number;
}

export const MAX_PENDING_EMAILS = 100;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MESSAGE_TIMEOUT_MS = 60_000;

type PendingEmailJob = () => Promise<void>;

interface SmtpResponse {
  code: number;
  lines: string[];
  text: string;
}

const emailQueue = { pending: [] as PendingEmailJob[], active: false };
let loggedUnconfigured = false;

function isTrueish(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function isFalseish(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "no";
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Parse SMTP_* env vars into a config object; null when email is not configured. */
export function readSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const rawFrom = env.SMTP_FROM;
  if (!host || !rawFrom?.trim()) {
    return null;
  }

  // A malformed SMTP_FROM is a deployment error: fail loudly (typed error,
  // raw value never echoed) instead of sending an injectable envelope address.
  const validatedFrom = assertValidMailbox(rawFrom, "SMTP_FROM");
  return {
    host,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) || 587 : 587,
    secure: isTrueish(env.SMTP_SECURE),
    user: env.SMTP_USER?.trim() || undefined,
    password: env.SMTP_PASSWORD || undefined,
    from: validatedFrom.address,
    fromName: validatedFrom.name,
    tlsRejectUnauthorized: !isFalseish(env.SMTP_TLS_REJECT_UNAUTHORIZED),
    allowInsecureAuth: env.SMTP_ALLOW_INSECURE_AUTH === "true",
    connectTimeoutMs: parseTimeoutMs(env.SMTP_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
    messageTimeoutMs: parseTimeoutMs(env.SMTP_MESSAGE_TIMEOUT_MS, DEFAULT_MESSAGE_TIMEOUT_MS),
  };
}

/**
 * Whether email is usable: SMTP_HOST AND a syntactically valid SMTP_FROM are
 * set. An invalid SMTP_FROM is not "configured" — the typed error is logged
 * (raw value never echoed) and the channel reports unconfigured instead of
 * throwing into every caller.
 */
export function isEmailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return readSmtpConfig(env) !== null;
  } catch (error) {
    if (error instanceof InvalidEmailAddressError) {
      console.error(`[email] SMTP_FROM is invalid; email is treated as unconfigured: ${error.message}`);
      return false;
    }
    throw error;
  }
}

/** Wrap a payload into base64 lines of at most 76 characters (7-bit safe bodies). */
export function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** SMTP DATA dot-stuffing: any line starting with "." gets an extra leading dot. */
export function dotStuff(payload: string): string {
  return payload
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export interface BuiltEmail {
  /** Full DATA payload (headers + body), without dot-stuffing or the final "." */
  data: string;
  mailFrom: string;
  rcptTo: string;
}

/** Build the RFC 5322 message: 7-bit-safe headers, multipart/alternative body. */
export function buildMimeMessage(message: OutgoingEmailMessage, config: SmtpConfig): BuiltEmail {
  // Defense in depth: this builder interpolates addresses into wire data, so
  // it re-validates even though sendEmail checked already — a direct call can
  // never smuggle CRLF or extra commands through.
  const validatedFrom = assertValidMailbox(config.from, "SMTP from address");
  const validatedTo = assertValidMailbox(message.to, "recipient address");

  const boundary = `taskito-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const fromAddress = validatedFrom.address;
  const fromName = config.fromName ?? validatedFrom.name;
  const domain = fromAddress.split("@")[1] ?? config.host;
  // Display names are CR/LF stripped / RFC 2047 encoded / quoted so they can
  // never add header structure.
  const fromDisplayName = encodeDisplayName(fromName ?? "");
  const fromLine = fromDisplayName ? `${fromDisplayName} <${fromAddress}>` : `<${fromAddress}>`;
  const toDisplayName = encodeDisplayName(message.toName ?? "");
  const toLine = toDisplayName ? `${toDisplayName} <${validatedTo.address}>` : `<${validatedTo.address}>`;

  const headers = [
    `From: ${fromLine}`,
    `To: ${toLine}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <taskito-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");

  const part = (contentType: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${contentType}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(body, "utf8").toString("base64")),
    ].join("\r\n");

  const data = [
    headers,
    "",
    part("text/plain", message.text),
    part("text/html", message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return { data, mailFrom: fromAddress, rcptTo: validatedTo.address };
}

interface ResponseWaiter {
  readResponse(): Promise<SmtpResponse>;
  dispose(): void;
}

function createResponseWaiter(socket: SmtpSocketLike, timeoutMs: number): ResponseWaiter {
  let buffer = "";

  const readResponse = (): Promise<SmtpResponse> =>
    new Promise((resolve, reject) => {
      const lines: string[] = [];
      const cleanup = () => {
        clearTimeout(timer);
        socket.off?.("data", onData);
        socket.off?.("error", onError);
        socket.off?.("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        // A command timeout means this server is no longer making progress.
        // Close immediately, rather than relying solely on the caller's
        // finally block, so the one-worker queue is freed promptly.
        socket.destroy();
        reject(new Error("[smtp] timed out waiting for server response"));
      }, timeoutMs);

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString("utf8");
        let lineEnd = buffer.indexOf("\r\n");
        while (lineEnd !== -1) {
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);
          lines.push(line);
          // A reply ends on the first line with a space after the status code.
          if (/^\d{3}(?:$| )/.test(line)) {
            cleanup();
            resolve({ code: Number(line.slice(0, 3)), lines, text: lines.join("\n") });
            return;
          }
          lineEnd = buffer.indexOf("\r\n");
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("[smtp] connection closed while waiting for a response"));
      };

      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
    });

  return { readResponse, dispose: () => {} };
}

/** Strip the "250-" / "250 " SMTP status prefix from EHLO capability lines. */
function stripStatusPrefixes(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^\d{3}[ -]/, ""));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Bounded, PII-free status summary for logs: the 3-digit status code plus the
 * RFC 3463 enhanced status code only — never the server's reply text, which
 * can echo envelope data or other PII.
 */
function responseStatusSummary(response: SmtpResponse): string {
  const enhanced = response.lines[0]?.match(/^\d{3}[ -](\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  return `${response.code}${enhanced ? ` ${enhanced[1]}` : ""}`;
}

/** Run the whole SMTP conversation over an established connection. */
async function runSmtpConversation(
  connection: SmtpConnection,
  message: OutgoingEmailMessage,
  config: SmtpConfig,
  responseTimeoutMs: number
): Promise<void> {
  let waiter!: ResponseWaiter;
  let commandSocket: SmtpSocketLike;

  const bindCommands = (socket: SmtpSocketLike) => {
    commandSocket = socket;
    waiter = createResponseWaiter(socket, responseTimeoutMs);

    const send = (command: string) => {
      commandSocket.write(`${command}\r\n`);
      return waiter.readResponse();
    };
    /**
     * Security (H1): `label` is a constant, credential-free description of
     * the command. During AUTH LOGIN the wire command itself IS the
     * credential (single-token base64), so deriving the label from the
     * command would leak the password into thrown errors and logs. Error
     * messages carry only the label plus the bounded status summary below —
     * never command arguments and never the server's reply text.
     */
    const expect = async (label: string, command: string, codes: number[]) => {
      const response = await send(command);
      if (!codes.includes(response.code)) {
        throw new Error(`[smtp] unexpected reply to ${label}: ${responseStatusSummary(response)}`);
      }
      return response;
    };
    return { send, expect };
  };

  let { send, expect } = bindCommands(connection.socket);

  const greeting = await waiter.readResponse();
  if (greeting.code !== 220) {
    throw new Error(`[smtp] unexpected greeting: ${responseStatusSummary(greeting)}`);
  }

  const parsedFrom = parseEmailAddress(config.from);
  const ehloDomain = parsedFrom.address.split("@")[1] ?? config.host;
  let capabilities = stripStatusPrefixes((await expect("EHLO", `EHLO ${ehloDomain}`, [250])).lines);

  // Whether the command stream is encrypted: either implicit TLS from the
  // start (config.secure) or a completed STARTTLS upgrade.
  let tlsActive = config.secure;

  if (!config.secure && capabilities.some((line) => line.toUpperCase().startsWith("STARTTLS"))) {
    await expect("STARTTLS", "STARTTLS", [220]);
    const secureSocket = await connection.upgrade();
    tlsActive = true;
    // Re-bind command/response plumbing to the TLS layer so raw TLS records
    // are not parsed as SMTP reply lines, then re-run EHLO for fresh caps.
    waiter.dispose();
    ({ send, expect } = bindCommands(secureSocket));
    capabilities = stripStatusPrefixes((await expect("EHLO", `EHLO ${ehloDomain}`, [250])).lines);
  }

  if (config.user && config.password) {
    // Security: never send credentials as plaintext over an unencrypted link.
    // The only escape hatch is an explicit operator opt-in.
    if (!tlsActive && !config.allowInsecureAuth) {
      throw new Error(
        "[smtp] refusing to send credentials without TLS; set SMTP_SECURE=true, use a STARTTLS-capable server, or set SMTP_ALLOW_INSECURE_AUTH=true"
      );
    }
    if (capabilities.some((line) => line.toUpperCase().includes("AUTH") && line.toUpperCase().includes("PLAIN"))) {
      const initialResponse = Buffer.from(`\u0000${config.user}\u0000${config.password}`, "utf8").toString("base64");
      await expect("AUTH PLAIN", `AUTH PLAIN ${initialResponse}`, [235]);
    } else if (capabilities.some((line) => line.toUpperCase().includes("AUTH") && line.toUpperCase().includes("LOGIN"))) {
      await expect("AUTH LOGIN", "AUTH LOGIN", [334]);
      // AUTH LOGIN steps send the credentials as standalone one-token base64
      // commands: the safe labels below are what can ever appear in errors.
      await expect("AUTH LOGIN username", Buffer.from(config.user, "utf8").toString("base64"), [334]);
      await expect("AUTH LOGIN password", Buffer.from(config.password, "utf8").toString("base64"), [235]);
    } else {
      throw new Error("[smtp] server does not advertise a supported AUTH mechanism");
    }
  }

  const built = buildMimeMessage(message, config);
  await expect("MAIL FROM", `MAIL FROM:<${built.mailFrom}>`, [250]);
  await expect("RCPT TO", `RCPT TO:<${built.rcptTo}>`, [250, 251]);
  await expect("DATA", "DATA", [354]);

  const dotStuffed = dotStuff(built.data);
  const response = await new Promise<SmtpResponse>((resolve, reject) => {
    commandSocket.write(`${dotStuffed}\r\n.\r\n`, () => {
      waiter.readResponse().then(resolve, reject);
    });
  });
  if (response.code !== 250) {
    throw new Error(`[smtp] message was not accepted: ${responseStatusSummary(response)}`);
  }

  await send("QUIT");
}

function defaultConnectionFactory(config: SmtpConfig, connectTimeoutMs: number): SmtpConnectionFactory {
  return async () => {
    const socket: net.Socket | tls.TLSSocket = config.secure
      ? tls.connect({ host: config.host, port: config.port, rejectUnauthorized: config.tlsRejectUnauthorized })
      : net.connect({ host: config.host, port: config.port });

    // TCP connect + implicit-TLS handshake deadline: a black-holed endpoint
    // must destroy the socket and abort the job, never pin the queue worker.
    await new Promise<void>((resolve, reject) => {
      const connectEvent = config.secure ? "secureConnect" : "connect";
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`[smtp] connect timeout: ${config.host}:${config.port} did not complete the ${config.secure ? "TLS" : "TCP"} connection within ${Math.round(connectTimeoutMs)}ms`));
      }, connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off(connectEvent, onConnect);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once(connectEvent, onConnect);
      socket.once("error", onError);
    });

    let current: SmtpSocketLike = socket;
    return {
      socket,
      upgrade: async () => {
        const tlsOptions: tls.ConnectionOptions = {
          socket,
          host: config.host,
          port: config.port,
          rejectUnauthorized: config.tlsRejectUnauthorized,
        };
        // STARTTLS upgrade has its own handshake deadline; the plaintext
        // socket is destroyed so the queue can advance.
        const secureSocket: tls.TLSSocket = await new Promise((resolve, reject) => {
          const upgraded = tls.connect(tlsOptions, () => {
            clearTimeout(handshakeTimer);
            resolve(upgraded);
          });
          const handshakeTimer = setTimeout(() => {
            upgraded.destroy();
            socket.destroy();
            reject(new Error(`[smtp] STARTTLS handshake timeout after ${Math.round(connectTimeoutMs)}ms`));
          }, connectTimeoutMs);
          upgraded.once("error", (error: Error) => {
            clearTimeout(handshakeTimer);
            reject(error);
          });
        });
        current = secureSocket;
        return secureSocket;
      },
      close: () => current.destroy(),
    };
  };
}

/**
 * Send an email directly. Resolves as a no-op when SMTP is not configured
 * (logs once so operators notice a half-configured deployment).
 *
 * Security: the recipient address is validated strictly BEFORE any socket is
 * opened — an invalid/injection-shaped `to` (or `config.from`) rejects with a
 * typed `InvalidEmailAddressError` and can never reach MAIL/RCPT lines. The
 * whole conversation runs under an overall per-message deadline; on any
 * timeout the socket is destroyed so the queue advances.
 */
export async function sendEmail(message: OutgoingEmailMessage, options: SmtpSendOptions = {}): Promise<void> {
  const config = options.config ?? readSmtpConfig();
  if (!config) {
    if (!loggedUnconfigured) {
      console.warn("[email] SMTP is not configured (set SMTP_HOST and SMTP_FROM); skipping email send");
      loggedUnconfigured = true;
    }
    return;
  }

  // H2: envelope + recipient validation before connecting. buildMimeMessage
  // re-validates (defense in depth); this check is what keeps a hostile
  // address from ever opening a connection.
  assertValidMailbox(config.from, "SMTP from address");
  assertValidMailbox(message.to, "recipient address");

  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const messageTimeoutMs = options.messageTimeoutMs ?? config.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS;
  const factory = options.connectionFactory ?? defaultConnectionFactory(config, connectTimeoutMs);
  const messageDeadlineAt = Date.now() + messageTimeoutMs;

  let connection: SmtpConnection | undefined;
  try {
    // The deadline covers everything: connect/handshake (the default factory
    // also enforces its own stricter connect timeout) through QUIT. When it
    // fires we destroy the socket so the pending job fails fast and the
    // single queue worker moves on to the next message.
    // A custom connection factory can hang before it returns a connection.
    // If it resolves after the deadline, still close that late socket so the
    // abandoned attempt cannot leak a connection.
    let connectionFactoryTimedOut = false;
    const pendingConnection = factory().then((lateConnection) => {
      if (connectionFactoryTimedOut) {
        lateConnection.close();
      }
      return lateConnection;
    });
    connection = await withDeadline(
      pendingConnection,
      messageTimeoutMs,
      "SMTP connection was not established within the per-message deadline",
      () => {
        connectionFactoryTimedOut = true;
      }
    );
    const remainingConversationMs = messageDeadlineAt - Date.now();
    if (remainingConversationMs <= 0) {
      throw new Error(
        `[smtp] SMTP conversation did not finish within the per-message deadline (deadline ${Math.round(messageTimeoutMs)}ms exceeded)`
      );
    }
    await withDeadline(
      runSmtpConversation(connection, message, config, responseTimeoutMs),
      remainingConversationMs,
      "SMTP conversation did not finish within the per-message deadline",
      () => connection?.close()
    );
  } finally {
    connection?.close();
  }
}

export function logEmailError(context: string, error: unknown): void {
  // Never include SMTP credentials in logs — only the shape of the failure.
  console.error(`[email] ${context}:`, describeError(error));
}

/**
 * Race `promise` against a hard deadline. On timeout the promise is left
 * behind (its own timeouts/finally will clean up) and the returned one
 * rejects with a bounded error so the caller can destroy the socket and let
 * the queue advance.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`[smtp] ${message} (deadline ${Math.round(timeoutMs)}ms exceeded)`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fire-and-forget send through a small bounded queue.
 * Returns "queued" or "dropped" (queue holds at most MAX_PENDING_EMAILS jobs).
 */
export function queueEmail(message: OutgoingEmailMessage): "queued" | "dropped" {
  return enqueueEmailJob(() => sendEmail(message));
}

export function enqueueEmailJob(job: PendingEmailJob): "queued" | "dropped" {
  if (emailQueue.pending.length >= MAX_PENDING_EMAILS) {
    console.warn(`[email] send queue is full (${MAX_PENDING_EMAILS} pending); dropping email job`);
    return "dropped";
  }
  emailQueue.pending.push(job);
  void drainEmailQueue();
  return "queued";
}

async function drainEmailQueue(): Promise<void> {
  if (emailQueue.active) {
    return;
  }
  emailQueue.active = true;
  try {
    while (emailQueue.pending.length > 0) {
      const job = emailQueue.pending.shift();
      if (!job) break;
      try {
        await job();
      } catch (error) {
        logEmailError("queued email job failed", error);
      }
    }
  } finally {
    emailQueue.active = false;
  }
}

export function pendingEmailCount(): number {
  return emailQueue.pending.length + (emailQueue.active ? 1 : 0);
}

/** Test helper: waits until the queue is fully drained. */
export async function flushEmailQueueForTests(): Promise<void> {
  while (emailQueue.active || emailQueue.pending.length > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Test helper: resets queue + "unconfigured" logging state. */
export function resetEmailQueueForTests(): void {
  emailQueue.pending = [];
  emailQueue.active = false;
  loggedUnconfigured = false;
}
