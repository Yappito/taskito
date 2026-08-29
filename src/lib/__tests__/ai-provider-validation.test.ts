import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import {
  assertAiProviderBaseUrlFetchAllowed,
  normalizeAiProviderHeaders,
  normalizeAiProviderModel,
  validateAiProviderBaseUrl,
} from "@/lib/ai-provider-validation";
import { fetchAiProvider } from "@/server/services/ai/provider-request";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";

// The module code always calls lookup with the `{ all: true, verbatim: true }` overload,
// so type the mock against the LookupAddress[] signature that overload returns.
type LookupAllOptions = { all: true; verbatim: true };
const lookupMock = vi.mocked(lookup) as unknown as Mock<
  (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>
>;

function mockResolvedAddresses(addresses: LookupAddress[]) {
  lookupMock.mockResolvedValue(addresses);
}

const originalAllowPrivateHosts = process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS;
const originalAllowlist = process.env.AI_PROVIDER_HOST_ALLOWLIST;

afterEach(() => {
  if (originalAllowPrivateHosts === undefined) {
    delete process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS;
  } else {
    process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = originalAllowPrivateHosts;
  }
  if (originalAllowlist === undefined) {
    delete process.env.AI_PROVIDER_HOST_ALLOWLIST;
  } else {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = originalAllowlist;
  }
});

describe("ai-provider-validation", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    delete process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS;
    delete process.env.AI_PROVIDER_HOST_ALLOWLIST;
  });

  it("normalizes a valid provider URL", () => {
    expect(validateAiProviderBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("allows HTTP provider URLs", () => {
    expect(validateAiProviderBaseUrl("http://api.example.com/v1")).toBe("http://api.example.com/v1");
  });

  it("rejects IP literals that are loopback or private by default", () => {
    const blockedUrls = [
      "http://127.0.0.1:11434/v1",
      "http://127.8.8.8",
      "http://10.0.0.1/v1",
      "http://172.16.0.1/v1",
      "http://192.168.1.1/v1",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/v1",
      "http://0.0.0.0/v1",
      "http://[::1]:11434/v1",
      "http://[fe80::1]/v1",
      "http://[fd12::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://localhost:11434",
    ];

    for (const blockedUrl of blockedUrls) {
      expect(() => validateAiProviderBaseUrl(blockedUrl), blockedUrl).toThrow(/private, loopback, or link-local/);
    }
  });

  it("rejects credentials in provider URLs", () => {
    expect(() => validateAiProviderBaseUrl("https://user:pass@api.example.com/v1")).toThrow(/must not include credentials/);
  });

  it("rejects non-HTTP provider schemes", () => {
    expect(() => validateAiProviderBaseUrl("ftp://api.example.com/v1")).toThrow(/must use HTTP or HTTPS/);
    expect(() => validateAiProviderBaseUrl("file:///etc/passwd")).toThrow(/must use HTTP or HTTPS/);
  });

  it("accepts private hosts when AI_PROVIDER_ALLOW_PRIVATE_HOSTS is true", () => {
    process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = "true";
    expect(validateAiProviderBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(validateAiProviderBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("accepts private hosts when the allowlist contains an exact `host:port` entry", () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "10.0.0.5:443,localhost:11434";
    expect(validateAiProviderBaseUrl("https://10.0.0.5/v1")).toBe("https://10.0.0.5/v1");
    expect(validateAiProviderBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
    // With a non-empty allowlist, non-allowlisted hosts are denied by the allowlist gate.
    expect(() => validateAiProviderBaseUrl("https://192.168.1.1/v1")).toThrow(/not present in the allowlist/);
  });

  it("rejects private literal hosts even when a different allowlist is set", () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
    expect(() => validateAiProviderBaseUrl("https://10.0.0.1/v1")).toThrow(/not present in the allowlist/);
    expect(validateAiProviderBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
  });

  it("rejects private hosts that only have a bare (port-less) allowlist entry", () => {
    // A bare `localhost` entry used to open every TCP port on the host.
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "localhost";
    expect(() => validateAiProviderBaseUrl("http://localhost:11434/")).toThrow(/private, loopback, or link-local/);
  });

  it("still lets bare entries match any port on public hosts", () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
    expect(validateAiProviderBaseUrl("http://api.example.com:9000/v1")).toBe("http://api.example.com:9000/v1");
  });

  it("matches allowlist `host:port` entries against the URL's effective port", () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "localhost:11434";
    expect(validateAiProviderBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
    expect(() => validateAiProviderBaseUrl("http://localhost:8080/v1")).toThrow(/not present in the allowlist/);
    // https defaults to port 443, so a `:443` entry accepts it implicitly.
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com:443";
    expect(validateAiProviderBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(() => validateAiProviderBaseUrl("http://api.example.com/v1")).toThrow(/not present in the allowlist/);
  });

  it("drops malformed allowlist entries and still applies the valid ones", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com:not-a-port,api.example.com";
    expect(validateAiProviderBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(() => validateAiProviderBaseUrl("https://other.example.com/v1")).toThrow(/not present in the allowlist/);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("accepts an https public host", () => {
    expect(validateAiProviderBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1");
  });

  describe("assertAiProviderBaseUrlFetchAllowed (resolved addresses)", () => {
    it("rejects a hostname that resolves to a public and a private address", async () => {
      mockResolvedAddresses([
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.10", family: 4 },
      ]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://api.example.com/v1")).rejects.toThrow(
        /resolves to a private, loopback, or link-local address/
      );
    });

    it("rejects a hostname that resolves to a private IPv4-mapped IPv6 address", async () => {
      mockResolvedAddresses([{ address: "::ffff:127.0.0.1", family: 6 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://api.example.com/v1")).rejects.toThrow(
        /resolves to a private/
      );
    });

    it("rejects a hostname that resolves only to ::1", async () => {
      mockResolvedAddresses([{ address: "::1", family: 6 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://ip6-localhost")).rejects.toThrow(/resolves to a private/);
    });

    it("accepts a hostname that resolves to a public address", async () => {
      mockResolvedAddresses([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://api.example.com/v1")).resolves.toBe(
        "http://api.example.com/v1"
      );
    });

    it("rejects a host whose DNS resolution returns only loopback addresses", async () => {
      mockResolvedAddresses([
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ]);

      // A plain hostname is caught by the resolved-address check...
      await expect(assertAiProviderBaseUrlFetchAllowed("http://internal-dns.example")).rejects.toThrow(
        /resolves to a private, loopback, or link-local/
      );
      // ...while the literal "localhost" name is already rejected by the hostname guard.
      mockResolvedAddresses([
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ]);
      await expect(assertAiProviderBaseUrlFetchAllowed("http://localhost:11434")).rejects.toThrow(
        /private, loopback, or link-local/
      );
    });

    it("accepts a private host when AI_PROVIDER_ALLOW_PRIVATE_HOSTS is true", async () => {
      process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = "true";
      mockResolvedAddresses([{ address: "127.0.0.1", family: 4 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://localhost:11434")).resolves.toBe("http://localhost:11434");
    });

    it("accepts a private host when the allowlist has an exact `host:port` entry", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "localhost:11434";
      mockResolvedAddresses([{ address: "127.0.0.1", family: 4 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://localhost:11434")).resolves.toBe("http://localhost:11434");
    });

    it("strips brackets before the DNS lookup for a loopback IPv6 literal (L11)", async () => {
      process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = "true";
      mockResolvedAddresses([{ address: "::1", family: 6 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://[::1]:11434")).resolves.toBe("http://[::1]:11434");
      // The resolver must receive the bare address, not the bracketed form.
      expect(lookupMock).toHaveBeenCalledWith("::1", { all: true, verbatim: true });
    });

    it("resolves a public IPv6 literal without the brackets (L11)", async () => {
      const publicIpv6 = "2606:2800:220:1:248:1893:25c8:1946";
      mockResolvedAddresses([{ address: publicIpv6, family: 6 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed(`http://[${publicIpv6}]/v1`)).resolves.toBe(
        `http://[${publicIpv6}]/v1`,
      );
      expect(lookupMock).toHaveBeenCalledWith(publicIpv6, { all: true, verbatim: true });
    });

    it("rejects a bracketed private IPv6 literal without overrides (hostname guard)", async () => {
      mockResolvedAddresses([{ address: "fe80::1", family: 6 }]);

      // The literal itself is private, so normalizeBaseUrl rejects before any
      // DNS lookup happens.
      await expect(assertAiProviderBaseUrlFetchAllowed("http://[fe80::1]:11434")).rejects.toThrow(
        /points at a private, loopback, or link-local/,
      );
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it("no longer authorizes a private host via a bare allowlist entry", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "localhost";
      mockResolvedAddresses([{ address: "127.0.0.1", family: 4 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://localhost:11434")).rejects.toThrow(
        /private, loopback, or link-local/,
      );
    });

    it("rejects a private host when the allowlist contains only other hosts", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
      mockResolvedAddresses([{ address: "192.168.0.20", family: 4 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("https://10.0.0.5/v1")).rejects.toThrow(/not present in the allowlist/);
    });
  });

  describe("fetchAiProvider", () => {
    it("re-validates resolved addresses immediately before fetching", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      mockResolvedAddresses([{ address: "169.254.169.254", family: 4 }]);

      await expect(fetchAiProvider("http://api.example.com/v1", { method: "POST" })).rejects.toThrow(
        /resolves to a private/
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("fetches the validated URL for public hosts", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      mockResolvedAddresses([{ address: "93.184.216.34", family: 4 }]);

      await expect(fetchAiProvider("http://api.example.com/v1/chat/completions")).resolves.toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });
  });

  describe("fetchAiProvider redirects (manual hop-by-hop validation)", () => {
    interface RecordedFetch {
      url: string;
      init: RequestInit | undefined;
      method: string;
      headers: Record<string, string>;
      rawBody: string | undefined;
    }

    let restoreFake: (() => void) | undefined;

    afterEach(() => {
      if (restoreFake) {
        restoreFake();
        restoreFake = undefined;
      }
    });

    function installRecordingFetch(handlers: Array<() => Response>) {
      const requests: RecordedFetch[] = [];
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers: Record<string, string> = {};
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
        }
        const request: RecordedFetch = {
          url,
          init,
          method: (init?.method ?? "GET").toUpperCase(),
          headers,
          rawBody: typeof init?.body === "string" ? init.body : undefined,
        };
        requests.push(request);
        const handler = handlers[requests.length - 1];
        if (!handler) {
          throw new Error(`unexpected fetch #${requests.length} to ${url}`);
        }
        return handler();
      });
      vi.stubGlobal("fetch", fetchSpy);
      return { requests, fetchSpy, restore: () => vi.unstubAllGlobals() };
    }

    it("rejects a 307 redirect to a target outside the allowlist before the second fetch", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787";
      mockResolvedAddresses([{ address: "127.0.0.1", family: 4 }]);

      const fake = installRecordingFetch([
        () => new Response(null, { status: 307, headers: { location: "http://redirect-target.example/v1" } }),
        () => {
          throw new Error("second hop must never be fetched");
        },
      ]);
      restoreFake = fake.restore;

      await expect(
        fetchAiProvider("http://127.0.0.1:8787/v1", {
          method: "POST",
          headers: { "x-api-key": "sk-secret", "content-type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        }),
      ).rejects.toThrow(/redirected to a disallowed target/);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].headers["x-api-key"]).toBe("sk-secret");
    });

    it("rejects a 307 redirect whose target resolves to a private address before the second fetch", async () => {
      // A validated public URL must never be allowed to hand over (307 keeps
      // the method and body) to a host that resolves into private address space.
      lookupMock
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValue([{ address: "10.0.0.9", family: 4 }]);

      const fake = installRecordingFetch([
        () => new Response(null, { status: 307, headers: { location: "http://redirect-target.example/v1" } }),
        () => {
          throw new Error("second hop must never be fetched");
        },
      ]);
      restoreFake = fake.restore;

      await expect(
        fetchAiProvider("http://api.example.com/v1", { method: "POST", body: "x" }),
      ).rejects.toThrow(/redirected to a disallowed target/);
      expect(fake.requests).toHaveLength(1);
    });

    it("follows a 302 to an allowlisted public origin as a GET without credential headers", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787,api.example.com";
      mockResolvedAddresses([{ address: "93.184.216.34", family: 4 }]);

      const fake = installRecordingFetch([
        () => new Response(null, { status: 302, headers: { location: "http://api.example.com/v1" } }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
      ]);
      restoreFake = fake.restore;

      const response = await fetchAiProvider("http://127.0.0.1:8787/v1/test", {
        method: "POST",
        headers: { authorization: "Bearer sk-secret", "x-api-key": "sk-secret", "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({ ok: true });

      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0].method).toBe("POST");
      expect(fake.requests[0].rawBody).toBe(JSON.stringify({ messages: [] }));
      expect(fake.requests[1].method).toBe("GET");
      expect(fake.requests[1].rawBody).toBeUndefined();
      expect(fake.requests[1].headers["authorization"]).toBeUndefined();
      expect(fake.requests[1].headers["x-api-key"]).toBeUndefined();
    });

    it("still re-sends the body for a 307 to an allowlisted target", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787,api.example.com";
      mockResolvedAddresses([{ address: "93.184.216.34", family: 4 }]);

      const fake = installRecordingFetch([
        () => new Response(null, { status: 307, headers: { location: "http://api.example.com/v1" } }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
      ]);
      restoreFake = fake.restore;

      const response = await fetchAiProvider("http://127.0.0.1:8787/v1/test", {
        method: "POST",
        headers: { authorization: "Bearer sk-secret", "x-api-key": "sk-secret" },
        body: JSON.stringify({ messages: [] }),
      });
      expect(response.ok).toBe(true);

      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[1].method).toBe("POST");
      expect(fake.requests[1].rawBody).toBe(JSON.stringify({ messages: [] }));
      // Cross-origin: credentials are stripped even when the method/body survive.
      expect(fake.requests[1].headers["authorization"]).toBeUndefined();
      expect(fake.requests[1].headers["x-api-key"]).toBeUndefined();
    });

    it("rejects a redirect loop after the configured hop budget", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "127.0.0.1:8787";
      mockResolvedAddresses([{ address: "127.0.0.1", family: 4 }]);

      const fake = installRecordingFetch([
        () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/loop" } }),
        () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/loop" } }),
        () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/loop" } }),
        () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/loop" } }),
        () => {
          throw new Error("fifth hop must never be fetched");
        },
      ]);
      restoreFake = fake.restore;

      await expect(fetchAiProvider("http://127.0.0.1:8787/v1/start")).rejects.toThrow(/redirected too many times/);
      // Initial request + 3 followed redirects; the 5th hop is never attempted.
      expect(fake.requests).toHaveLength(4);
    });
  });

  it("normalizes provider model names", () => {
    expect(normalizeAiProviderModel(" gpt-4.1-mini ")).toBe("gpt-4.1-mini");
  });

  it("normalizes string headers", () => {
    expect(normalizeAiProviderHeaders({ "X-Test": " value " })).toEqual({ "X-Test": "value" });
  });

  it("rejects reserved provider headers", () => {
    expect(() => normalizeAiProviderHeaders({ Authorization: "Bearer x" })).toThrow(/managed by Taskito/);
  });
});