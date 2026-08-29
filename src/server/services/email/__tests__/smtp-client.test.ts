import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampSmtpUnitTimeoutMs,
  dotStuff,
  encodeHeaderValue,
  enqueueEmailJob,
  flushEmailQueueForTests,
  isEmailConfigured,
  MAX_PENDING_EMAILS,
  parseEmailAddress,
  pendingEmailCount,
  queueEmail,
  readSmtpConfig,
  resetEmailQueueForTests,
  SMTP_UNIT_TIMEOUT_MAX_MS,
  sendEmail,
  type SmtpConfig,
  type SmtpConnection,
} from "../smtp-client";

const testConfig: SmtpConfig = {
  host: "mail.local",
  port: 587,
  secure: false,
  user: "mailer@taskito.local",
  password: "super-secret",
  from: "Taskito <no-reply@taskito.local>",
  tlsRejectUnauthorized: true,
  allowInsecureAuth: false,
};

/** In-memory SMTP server side of a socket: replays scripted replies. */
class FakeSmtpSocket extends EventEmitter {
  written = "";
  closed = false;
  private pending = "";
  private awaitingDataEnd = false;

  constructor(
    private readonly replyTo: (line: string, socket: FakeSmtpSocket) => string[],
    private readonly tls: boolean
  ) {
    super();
  }

  /** Push a server reply to the read side (what the SMTP client listens to). */
  pushServer(response: string) {
    setImmediate(() => this.emit("data", Buffer.from(response + "\r\n")));
  }

  write(chunk: string, cb?: (error?: Error | null) => void): boolean {
    this.pending += chunk;
    let lineEnd = this.pending.indexOf("\r\n");
    while (lineEnd !== -1) {
      const line = this.pending.slice(0, lineEnd);
      this.pending = this.pending.slice(lineEnd + 2);
      this.written += line + "\r\n";
      const replies = this.replyTo(line, this);
      for (const reply of replies) {
        this.pushServer(reply);
      }
      lineEnd = this.pending.indexOf("\r\n");
    }
    cb?.();
    return true;
  }

  end(cb?: () => void) {
    this.closed = true;
    cb?.();
  }

  destroy() {
    this.closed = true;
    this.emit("close");
  }

  handlesTls() {
    return this.tls;
  }
}

function greeting(socket: FakeSmtpSocket) {
  socket.pushServer("220 mail.local ESMTP ready");
}

function fakeConnection(plain: FakeSmtpSocket, secure?: FakeSmtpSocket): { connection: SmtpConnection; upgraded: () => boolean } {
  let upgradedFlag = false;
  return {
    connection: {
      socket: plain,
      upgrade: async () => {
        upgradedFlag = true;
        if (!secure) throw new Error("unexpected upgrade");
        return secure;
      },
      close: () => plain.destroy(),
    },
    upgraded: () => upgradedFlag,
  };
}

const message = {
  to: "ada@example.com",
  toName: "Ada Lovelace",
  subject: "Hello",
  text: "Plain body",
  html: "<p>Html body</p>",
};

describe("smtp client env config", () => {
  it("parses config from env and reports email as configured", () => {
    const config = readSmtpConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "user",
      SMTP_PASSWORD: "pass",
      SMTP_FROM: "Taskito <noreply@example.com>",
      SMTP_TLS_REJECT_UNAUTHORIZED: "false",
    });
    expect(config).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "user",
      password: "pass",
      from: "noreply@example.com",
      fromName: "Taskito",
      tlsRejectUnauthorized: false,
      allowInsecureAuth: false,
      connectTimeoutMs: 10_000,
      messageTimeoutMs: 60_000,
    });
    expect(isEmailConfigured({ SMTP_HOST: "h", SMTP_FROM: "a@b.c" })).toBe(true);
    expect(isEmailConfigured({})).toBe(false);
    expect(isEmailConfigured({ SMTP_HOST: "h" })).toBe(false);
    expect(isEmailConfigured({ SMTP_FROM: "a@b.c" })).toBe(false);
  });

  it("parses SMTP_ALLOW_INSECURE_AUTH as an explicit true opt-in", () => {
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_FROM: "a@b.c", SMTP_ALLOW_INSECURE_AUTH: "true" })?.allowInsecureAuth).toBe(true);
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_FROM: "a@b.c", SMTP_ALLOW_INSECURE_AUTH: "1" })?.allowInsecureAuth).toBe(false);
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_FROM: "a@b.c" })?.allowInsecureAuth).toBe(false);
  });

  it("defaults the port to 587 and TLS rejection to true", () => {
    const config = readSmtpConfig({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "a@b.c" });
    expect(config?.port).toBe(587);
    expect(config?.secure).toBe(false);
    expect(config?.tlsRejectUnauthorized).toBe(true);
  });

  // Wave-10 finding 2a: the per-unit SMTP timeouts had NO upper bound, so a
  // config typo could park the one-worker email queue for hours past the
  // scheduler lock safety margin. Both must clamp DOWN to
  // SCHEDULER_LOCK_TX_SAFETY_MARGIN_MS (300000ms) with a logged warning;
  // in-range values, lower bounds, and defaults are unchanged.
  it("clamps over-high SMTP unit timeouts to the scheduler lock safety margin (wave-10 finding 2a)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(SMTP_UNIT_TIMEOUT_MAX_MS).toBe(300_000);

      // Defaults stay below the cap and never warn.
      const defaults = readSmtpConfig({ SMTP_HOST: "h", SMTP_FROM: "a@b.c" });
      expect(defaults?.connectTimeoutMs).toBe(10_000);
      expect(defaults?.messageTimeoutMs).toBe(60_000);
      expect(warnSpy).not.toHaveBeenCalled();

      // Configured values above the cap clamp down to 300000, with a warning.
      const clamped = readSmtpConfig({
        SMTP_HOST: "h",
        SMTP_FROM: "a@b.c",
        SMTP_MESSAGE_TIMEOUT_MS: "999999",
        SMTP_CONNECT_TIMEOUT_MS: "600000",
      });
      expect(clamped?.messageTimeoutMs).toBe(300_000);
      expect(clamped?.connectTimeoutMs).toBe(300_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("SMTP_MESSAGE_TIMEOUT_MS"))).toBe(true);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("SMTP_CONNECT_TIMEOUT_MS"))).toBe(true);

      // In-range configured values pass through unchanged.
      const passthrough = readSmtpConfig({
        SMTP_HOST: "h",
        SMTP_FROM: "a@b.c",
        SMTP_MESSAGE_TIMEOUT_MS: "120000",
        SMTP_CONNECT_TIMEOUT_MS: "300000",
      });
      expect(passthrough?.messageTimeoutMs).toBe(120_000);
      expect(passthrough?.connectTimeoutMs).toBe(300_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("clamps programmatic sendEmail option timeouts to the margin too (defense in depth)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The sendEmail options path bypasses readSmtpConfig, so the effective
      // values are clamped at the point of use as well — a caller passing a
      // 900000ms message timeout gets the margin-capped 300000ms.
      expect(clampSmtpUnitTimeoutMs(900_000, "message timeout")).toBe(300_000);
      expect(clampSmtpUnitTimeoutMs(600_000, "connect timeout")).toBe(300_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("message timeout"))).toBe(true);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("connect timeout"))).toBe(true);
      // At/below the cap values pass through without a warning.
      expect(clampSmtpUnitTimeoutMs(300_000, "message timeout")).toBe(300_000);
      expect(clampSmtpUnitTimeoutMs(60_000, "message timeout")).toBe(60_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("parses plain addresses and display-name addresses", () => {
    expect(parseEmailAddress("noreply@example.com")).toEqual({ address: "noreply@example.com" });
    expect(parseEmailAddress('Taskito Ops <ops@example.com>')).toEqual({
      address: "ops@example.com",
      name: "Taskito Ops",
    });
  });

  it("rejects an injectable SMTP_FROM instead of treating email as configured", () => {
    const injected = "victim@example.com>\r\nRCPT TO:<attacker@example.com";
    expect(() => readSmtpConfig({ SMTP_HOST: "smtp.example.com", SMTP_FROM: injected })).toThrow(/CR\/LF/);
    expect(isEmailConfigured({ SMTP_HOST: "smtp.example.com", SMTP_FROM: injected })).toBe(false);
  });
});

describe("header encoding and dot stuffing", () => {
  it("leaves 7-bit ASCII subjects untouched", () => {
    expect(encodeHeaderValue("Task alert")).toBe("Task alert");
  });

  it("encodes non-ASCII as RFC 2047 B words that decode back to the original", () => {
    const subject = "Über wichtig: Привет — 测试";
    const encoded = encodeHeaderValue(subject);
    expect(encoded).toMatch(/=\?UTF-8\?B\?/);
    const decoded = encoded
      .split("\r\n ")
      .map((word) => {
        const m = word.match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/);
        if (!m) return word;
        return Buffer.from(m[1], "base64").toString("utf8");
      })
      .join("");
    expect(decoded).toBe(subject);
    // 7-bit safe
    expect(encoded.replace(/(=\?UTF-8\?B\?[\w+/=]+\?=)|[\x20-\x7e]/g, "")).toBe("");
  });

  it("dots-stuffs lines that would end the DATA section early", () => {
    expect(dotStuff("line one\r\n.leading dot\r\n...three dots\r\nlast")).toBe(
      "line one\r\n..leading dot\r\n....three dots\r\nlast"
    );
  });
});

describe("smtp conversation", () => {
  beforeEach(() => {
    resetEmailQueueForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes the happy path without auth or STARTTLS", async () => {
    const socket = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250 8BITMIME"];
      if (line.startsWith("MAIL FROM")) return ["250 2.1.0 Ok"];
      if (line.startsWith("RCPT TO")) return ["250 2.1.5 Ok"];
      if (line === "DATA") return ["354 End data with <CR><LF>.<CR><LF>"];
      if (line === ".") return ["250 2.0.0 Ok: queued as ABC123"];
      if (line === "QUIT") return ["221 2.0.0 Bye"];
      return [];
    }, false);

    const { connection } = fakeConnection(socket);
    await sendEmail(message, { config: { ...testConfig, user: undefined, password: undefined }, connectionFactory: () => {
      greeting(socket);
      return Promise.resolve(connection);
    }, responseTimeoutMs: 500 });

    expect(socket.written).toContain("EHLO taskito.local\r\n");
    expect(socket.written).toContain("MAIL FROM:<no-reply@taskito.local>\r\n");
    expect(socket.written).toContain("RCPT TO:<ada@example.com>\r\n");
    expect(socket.written).toContain("DATA\r\n");
    expect(socket.written).toContain("\r\n.\r\n");
    expect(socket.written).toContain("QUIT\r\n");
    // Headers + multipart/alternative structure
    expect(socket.written).toContain("From: Taskito <no-reply@taskito.local>\r\n");
    expect(socket.written).toContain("Subject: Hello\r\n");
    expect(socket.written).toContain("Content-Type: multipart/alternative");
    expect(socket.written).toContain("Content-Type: text/plain");
    expect(socket.written).toContain("Content-Type: text/html");
  });

  it("upgrades via STARTTLS and authenticates with AUTH PLAIN", async () => {
    const plain = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250-STARTTLS", "250-AUTH PLAIN LOGIN", "250 8BITMIME"];
      if (line === "STARTTLS") return ["220 2.0.0 Ready to start TLS"];
      return [];
    }, false);
    const secure = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250 AUTH PLAIN LOGIN"];
      if (line.startsWith("AUTH PLAIN")) return ["235 2.7.0 Accepted"];
      if (line.startsWith("MAIL FROM")) return ["250 2.1.0 Ok"];
      if (line.startsWith("RCPT TO")) return ["250 2.1.5 Ok"];
      if (line === "DATA") return ["354 Go ahead"];
      if (line === ".") return ["250 2.0.0 Ok: queued"];
      if (line === "QUIT") return ["221 2.0.0 Bye"];
      return [];
    }, true);

    const { connection, upgraded } = fakeConnection(plain, secure);
    await sendEmail(message, {
      config: testConfig,
      connectionFactory: () => {
        greeting(plain);
        return Promise.resolve(connection);
      },
      responseTimeoutMs: 500,
    });

    expect(upgraded()).toBe(true);
    // EHLO before and after the TLS handshake
    expect(plain.written).toContain("EHLO taskito.local\r\n");
    expect(plain.written).toContain("STARTTLS\r\n");
    expect(secure.written).toContain("EHLO taskito.local\r\n");
    const expectedAuth = Buffer.from(`\u0000${testConfig.user}\u0000${testConfig.password}`, "utf8").toString("base64");
    expect(secure.written).toContain(`AUTH PLAIN ${expectedAuth}\r\n`);
    expect(secure.written).toContain("DATA\r\n");
  });

  it("refuses to send credentials over plaintext when STARTTLS is not available", async () => {
    // AUTH is advertised, but the connection is plaintext and no STARTTLS is
    // offered: the client must bail out before any AUTH (or MAIL) line is sent.
    const socket = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250-AUTH PLAIN LOGIN", "250 8BITMIME"];
      return [];
    }, false);

    const { connection } = fakeConnection(socket);
    await expect(
      sendEmail(message, {
        config: testConfig,
        connectionFactory: () => {
          greeting(socket);
          return Promise.resolve(connection);
        },
        responseTimeoutMs: 500,
      })
    ).rejects.toThrow(/\[smtp\] refusing to send credentials without TLS; set SMTP_SECURE=true, use a STARTTLS-capable server, or set SMTP_ALLOW_INSECURE_AUTH=true/);

    expect(socket.written).toBe("EHLO taskito.local\r\n");
    expect(socket.written).not.toContain("AUTH");
    expect(socket.written).not.toContain("MAIL FROM");
  });

  it("still sends credentials over plaintext with SMTP_ALLOW_INSECURE_AUTH=true", async () => {
    const socket = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250-AUTH PLAIN LOGIN", "250 8BITMIME"];
      if (line.startsWith("AUTH PLAIN")) return ["235 2.7.0 Accepted"];
      if (line.startsWith("MAIL FROM")) return ["250 2.1.0 Ok"];
      if (line.startsWith("RCPT TO")) return ["250 2.1.5 Ok"];
      if (line === "DATA") return ["354 Go ahead"];
      if (line === ".") return ["250 2.0.0 Ok: queued"];
      if (line === "QUIT") return ["221 2.0.0 Bye"];
      return [];
    }, false);

    const { connection } = fakeConnection(socket);
    await sendEmail(message, {
      config: { ...testConfig, allowInsecureAuth: true },
      connectionFactory: () => {
        greeting(socket);
        return Promise.resolve(connection);
      },
      responseTimeoutMs: 500,
    });

    const expectedAuth = Buffer.from(`\u0000${testConfig.user}\u0000${testConfig.password}`, "utf8").toString("base64");
    expect(socket.written).toContain(`AUTH PLAIN ${expectedAuth}\r\n`);
    expect(socket.written).toContain("DATA\r\n");
    expect(socket.written).toContain("QUIT\r\n");
  });

  it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
    const userB64 = Buffer.from("mailer@taskito.local", "utf8").toString("base64");
    const passB64 = Buffer.from("super-secret", "utf8").toString("base64");
    const socket = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250 AUTH LOGIN"];
      if (line === "AUTH LOGIN") return ["334 VXNlcm5hbWU6"];
      if (line === userB64) return ["334 UGFzc3dvcmQ6"];
      if (line === passB64) return ["235 2.7.0 Accepted"];
      if (line.startsWith("MAIL FROM")) return ["250 Ok"];
      if (line.startsWith("RCPT TO")) return ["250 Ok"];
      if (line === "DATA") return ["354 Go ahead"];
      if (line === ".") return ["250 Ok"];
      if (line === "QUIT") return ["221 Bye"];
      return [];
    }, false);
    const { connection } = fakeConnection(socket);
    // Plaintext link without STARTTLS: exercises the LOGIN-mechanism fallback
    // only with the explicit insecure-auth opt-in (the refusal itself has its
    // own tests above).
    await sendEmail(message, {
      config: { ...testConfig, allowInsecureAuth: true },
      connectionFactory: () => {
        greeting(socket);
        return Promise.resolve(connection);
      },
      responseTimeoutMs: 500,
    });

    expect(socket.written).toContain("AUTH LOGIN\r\n");
    expect(socket.written).toContain(`${userB64}\r\n`);
    expect(socket.written).toContain(`${passB64}\r\n`);
  });

  it("never includes AUTH LOGIN credentials or server reply text in errors or queue logs", async () => {
    const password = "super-secret";
    const passwordB64 = Buffer.from(password, "utf8").toString("base64");
    const makeFailingConnection = () => {
      const socket = new FakeSmtpSocket((line) => {
        if (line.startsWith("EHLO")) return ["250-mail.local", "250 AUTH LOGIN"];
        if (line === "AUTH LOGIN") return ["334 VXNlcm5hbWU6"];
        if (line === Buffer.from("mailer@taskito.local", "utf8").toString("base64")) return ["334 UGFzc3dvcmQ6"];
        if (line === passwordB64) return [`535 5.7.8 rejected ${passwordB64} ${password}`];
        return [];
      }, true);
      const { connection } = fakeConnection(socket);
      return {
        socket,
        options: {
          config: { ...testConfig, secure: true, password },
          connectionFactory: () => {
            greeting(socket);
            return Promise.resolve(connection);
          },
          responseTimeoutMs: 500,
        },
      };
    };

    const direct = makeFailingConnection();
    const error = await sendEmail(message, direct.options).then(
      () => new Error("expected AUTH LOGIN to fail"),
      (reason: unknown) => reason as Error
    );
    expect(error.message).toContain("AUTH LOGIN password: 535 5.7.8");
    expect(error.message).not.toContain(passwordB64);
    expect(error.message).not.toContain(password);
    expect(error.message).not.toContain("rejected");

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const queued = makeFailingConnection();
    enqueueEmailJob(() => sendEmail(message, queued.options));
    await flushEmailQueueForTests();
    const output = logged.mock.calls.flat().map(String).join(" ");
    expect(output).not.toContain(passwordB64);
    expect(output).not.toContain(password);
    expect(output).not.toContain("rejected");
  });

  it("rejects a CRLF recipient before opening an SMTP connection", async () => {
    const injected = "victim@example.com>\r\nRCPT TO:<attacker@example.com";
    const factory = vi.fn();
    await expect(
      sendEmail(
        { ...message, to: injected },
        { config: { ...testConfig, user: undefined, password: undefined }, connectionFactory: factory }
      )
    ).rejects.toThrow(/CR\/LF/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("quotes ASCII-special display names in the MIME headers", async () => {
    const socket = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250 mail.local"];
      if (line.startsWith("MAIL FROM")) return ["250 Ok"];
      if (line.startsWith("RCPT TO")) return ["250 Ok"];
      if (line === "DATA") return ["354 Go ahead"];
      if (line === ".") return ["250 Ok"];
      if (line === "QUIT") return ["221 Bye"];
      return [];
    }, false);
    const { connection } = fakeConnection(socket);
    await sendEmail(
      { ...message, toName: 'Recipient <two>, "quoted"' },
      {
        config: {
          ...testConfig,
          user: undefined,
          password: undefined,
          from: "no-reply@taskito.local",
          fromName: 'Sender <one>, "quoted"',
        },
        connectionFactory: () => {
          greeting(socket);
          return Promise.resolve(connection);
        },
        responseTimeoutMs: 500,
      }
    );

    expect(socket.written).toContain('From: "Sender <one>, \\"quoted\\"" <no-reply@taskito.local>\r\n');
    expect(socket.written).toContain('To: "Recipient <two>, \\"quoted\\"" <ada@example.com>\r\n');
  });

  it("dot-stuffs the DATA payload when the body starts lines with dots", async () => {
    const socket = new FakeSmtpSocket((line) => {
      if (line.startsWith("EHLO")) return ["250-mail.local", "250 8BITMIME"];
      if (line.startsWith("MAIL FROM")) return ["250 Ok"];
      if (line.startsWith("RCPT TO")) return ["250 Ok"];
      if (line === "DATA") return ["354 Go ahead"];
      if (line === ".") return ["250 Ok"];
      if (line === "QUIT") return ["221 Bye"];
      return [];
    }, false);

    const { connection } = fakeConnection(socket);
    await sendEmail({ ...message, text: "leading\r\n...dots\r\nend" }, {
      config: { ...testConfig, user: undefined, password: undefined },
      connectionFactory: () => {
        greeting(socket);
        return Promise.resolve(connection);
      },
      responseTimeoutMs: 500,
    });

    // Bodies travel base64-encoded (7-bit safe), the payload terminator is the
    // classic CRLF.CRLF, and QUIT follows acceptance.
    expect(socket.written).toContain("\r\n.\r\n");
    const dataEnd = socket.written.indexOf("\r\n.\r\n");
    expect(socket.written.slice(dataEnd + 5)).toBe("QUIT\r\n");
    // A payload line that starts with a dot would be stuffed (unit test above);
    // verify no base64 content line collides with the terminator.
    expect(dotStuff("x=").endsWith("x=")).toBe(true);
  });

  it("does not throw or connect when SMTP is unconfigured", async () => {
    const factory = vi.fn();
    await expect(sendEmail(message, { config: null, connectionFactory: factory })).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(isEmailConfigured({})).toBe(false);
  });

  it("destroys a socket that never replies within the response timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSmtpSocket(() => [], false);
      const { connection } = fakeConnection(socket);
      const sending = sendEmail(message, {
        config: { ...testConfig, user: undefined, password: undefined },
        connectionFactory: () => Promise.resolve(connection),
        responseTimeoutMs: 25,
        messageTimeoutMs: 100,
      });
      const rejected = expect(sending).rejects.toThrow(/timed out waiting for server response/);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one message deadline across connection setup and the SMTP conversation", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSmtpSocket(() => [], false);
      const { connection } = fakeConnection(socket);
      const sending = sendEmail(message, {
        config: { ...testConfig, user: undefined, password: undefined },
        connectionFactory: () =>
          new Promise<SmtpConnection>((resolve) => {
            setTimeout(() => resolve(connection), 30);
          }),
        responseTimeoutMs: 100,
        messageTimeoutMs: 50,
      });
      const rejected = expect(sending).rejects.toThrow(/SMTP conversation did not finish within the per-message deadline/);
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bounded email queue", () => {
  beforeEach(() => {
    resetEmailQueueForTests();
  });

  it("drops jobs beyond 100 pending and logs once", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const blocker = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    let started = 0;
    const results: Array<"queued" | "dropped"> = [];
    results.push(enqueueEmailJob(() => { started += 1; return blocker; }));
    for (let i = 0; i < MAX_PENDING_EMAILS; i += 1) {
      results.push(enqueueEmailJob(async () => { started += 1; }));
    }
    // Queue now holds MAX_PENDING_EMAILS pending jobs (+ 1 active); further drop.
    expect(pendingEmailCount()).toBe(MAX_PENDING_EMAILS + 1);
    for (let i = 0; i < 5; i += 1) {
      results.push(enqueueEmailJob(async () => { started += 1; }));
    }
    expect(results.filter((r) => r === "dropped")).toHaveLength(5);
    expect(queueEmail(message)).toBe("dropped");

    gate.release();
    await flushEmailQueueForTests();
    expect(started).toBe(MAX_PENDING_EMAILS + 1);
    expect(pendingEmailCount()).toBe(0);
  });

  it("times out a hung connection factory and advances the queue to the next job", async () => {
    vi.useFakeTimers();
    try {
      let nextJobStarted = 0;
      enqueueEmailJob(() =>
        sendEmail(message, {
          config: { ...testConfig, user: undefined, password: undefined },
          connectionFactory: () => new Promise<SmtpConnection>(() => {}),
          messageTimeoutMs: 50,
        })
      );
      enqueueEmailJob(async () => {
        nextJobStarted += 1;
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(nextJobStarted).toBe(1);
      expect(pendingEmailCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
