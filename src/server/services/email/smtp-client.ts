import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

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
}

export const MAX_PENDING_EMAILS = 100;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;

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

/** Parse SMTP_* env vars into a config object; null when email is not configured. */
export function readSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  if (!host || !from) {
    return null;
  }

  const parsedFrom = parseEmailAddress(from);
  return {
    host,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) || 587 : 587,
    secure: isTrueish(env.SMTP_SECURE),
    user: env.SMTP_USER?.trim() || undefined,
    password: env.SMTP_PASSWORD || undefined,
    from: parsedFrom.address,
    fromName: parsedFrom.name,
    tlsRejectUnauthorized: !isFalseish(env.SMTP_TLS_REJECT_UNAUTHORIZED),
  };
}

export function isEmailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readSmtpConfig(env) !== null;
}

/** Split "Display Name <addr@host>" or "addr@host" into name + address. */
export function parseEmailAddress(value: string): { address: string; name?: string } {
  const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (!match) {
    return { address: value.trim() };
  }
  const name = match[1].trim().replace(/^"|"$/g, "");
  return { address: match[2].trim(), name: name || undefined };
}

/**
 * RFC 2047 "B" encoding for header values that must stay 7-bit safe
 * (used for the Subject and display names). Splits multi-byte UTF-8 safely
 * across multiple encoded words and folds them with CRLF + space.
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
  const boundary = `taskito-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const parsedFrom = parseEmailAddress(config.from);
  const fromAddress = parsedFrom.address;
  const fromName = config.fromName ?? parsedFrom.name;
  const domain = fromAddress.split("@")[1] ?? config.host;
  const fromLine = fromName
    ? `${encodeHeaderValue(fromName)} <${fromAddress}>`
    : `<${fromAddress}>`;
  const toLine = message.toName ? `${encodeHeaderValue(message.toName)} <${message.to}>` : `<${message.to}>`;

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

  return { data, mailFrom: fromAddress, rcptTo: message.to };
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
    const expect = async (command: string, codes: number[]) => {
      const response = await send(command);
      if (!codes.includes(response.code)) {
        throw new Error(
          `[smtp] unexpected reply to ${command.split(" ")[0]}: ${response.code} ${response.text}`
        );
      }
      return response;
    };
    return { send, expect };
  };

  let { send, expect } = bindCommands(connection.socket);

  const greeting = await waiter.readResponse();
  if (greeting.code !== 220) {
    throw new Error(`[smtp] unexpected greeting: ${greeting.code} ${greeting.text}`);
  }

  const parsedFrom = parseEmailAddress(config.from);
  const ehloDomain = parsedFrom.address.split("@")[1] ?? config.host;
  let capabilities = stripStatusPrefixes((await expect(`EHLO ${ehloDomain}`, [250])).lines);

  if (!config.secure && capabilities.some((line) => line.toUpperCase().startsWith("STARTTLS"))) {
    await expect("STARTTLS", [220]);
    const secureSocket = await connection.upgrade();
    // Re-bind command/response plumbing to the TLS layer so raw TLS records
    // are not parsed as SMTP reply lines, then re-run EHLO for fresh caps.
    waiter.dispose();
    ({ send, expect } = bindCommands(secureSocket));
    capabilities = stripStatusPrefixes((await expect(`EHLO ${ehloDomain}`, [250])).lines);
  }

  if (config.user && config.password) {
    if (capabilities.some((line) => line.toUpperCase().includes("AUTH") && line.toUpperCase().includes("PLAIN"))) {
      const initialResponse = Buffer.from(`\u0000${config.user}\u0000${config.password}`, "utf8").toString("base64");
      await expect(`AUTH PLAIN ${initialResponse}`, [235]);
    } else if (capabilities.some((line) => line.toUpperCase().includes("AUTH") && line.toUpperCase().includes("LOGIN"))) {
      await expect("AUTH LOGIN", [334]);
      await expect(Buffer.from(config.user, "utf8").toString("base64"), [334]);
      await expect(Buffer.from(config.password, "utf8").toString("base64"), [235]);
    } else {
      throw new Error("[smtp] server does not advertise a supported AUTH mechanism");
    }
  }

  const built = buildMimeMessage(message, config);
  await expect(`MAIL FROM:<${built.mailFrom}>`, [250]);
  await expect(`RCPT TO:<${built.rcptTo}>`, [250, 251]);
  await expect("DATA", [354]);

  const dotStuffed = dotStuff(built.data);
  const response = await new Promise<SmtpResponse>((resolve, reject) => {
    commandSocket.write(`${dotStuffed}\r\n.\r\n`, () => {
      waiter.readResponse().then(resolve, reject);
    });
  });
  if (response.code !== 250) {
    throw new Error(`[smtp] message was not accepted: ${response.code} ${response.text}`);
  }

  await send("QUIT");
}

function defaultConnectionFactory(config: SmtpConfig): SmtpConnectionFactory {
  return async () => {
    const socket: net.Socket | tls.TLSSocket = config.secure
      ? tls.connect({ host: config.host, port: config.port, rejectUnauthorized: config.tlsRejectUnauthorized })
      : net.connect({ host: config.host, port: config.port });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off(config.secure ? "secureConnect" : "connect", onConnect);
        reject(error);
      };
      socket.once(config.secure ? "secureConnect" : "connect", onConnect);
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
        const secureSocket: tls.TLSSocket = await new Promise((resolve, reject) => {
          const upgraded = tls.connect(tlsOptions, () => resolve(upgraded));
          upgraded.once("error", reject);
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

  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const factory = options.connectionFactory ?? defaultConnectionFactory(config);
  const connection = await factory();
  try {
    await runSmtpConversation(connection, message, config, responseTimeoutMs);
  } finally {
    connection.close();
  }
}

export function logEmailError(context: string, error: unknown): void {
  // Never include SMTP credentials in logs — only the shape of the failure.
  console.error(`[email] ${context}:`, describeError(error));
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