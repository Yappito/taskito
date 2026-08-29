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

  it("accepts private hosts that are present in the allowlist", () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "10.0.0.5";
    expect(validateAiProviderBaseUrl("https://10.0.0.5/v1")).toBe("https://10.0.0.5/v1");
    // With a non-empty allowlist, non-allowlisted hosts are denied by the allowlist gate.
    expect(() => validateAiProviderBaseUrl("https://192.168.1.1/v1")).toThrow(/not present in the allowlist/);
  });

  it("rejects private literal hosts even when a different allowlist is set", () => {
    process.env.AI_PROVIDER_HOST_ALLOWLIST = "api.example.com";
    expect(() => validateAiProviderBaseUrl("https://10.0.0.1/v1")).toThrow(/not present in the allowlist/);
    expect(validateAiProviderBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
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

    it("accepts a private host when the host is allowlisted", async () => {
      process.env.AI_PROVIDER_HOST_ALLOWLIST = "localhost";
      mockResolvedAddresses([{ address: "127.0.0.1", family: 4 }]);

      await expect(assertAiProviderBaseUrlFetchAllowed("http://localhost:11434")).resolves.toBe("http://localhost:11434");
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