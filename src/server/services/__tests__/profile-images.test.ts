import { describe, expect, it } from "vitest";
import { detectProfileImageType, getProfileImageLimits } from "@/server/services/profile-images";

describe("profile-images", () => {
  it("detects supported image signatures", () => {
    expect(detectProfileImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(detectProfileImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(
      detectProfileImageType(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
      )
    ).toBe("image/webp");
  });

  it("rejects unsupported image signatures", () => {
    expect(detectProfileImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBeNull();
    expect(detectProfileImageType(Uint8Array.from([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
  });

  it("publishes the expected upload limits", () => {
    expect(getProfileImageLimits()).toEqual({
      maxBytes: 2 * 1024 * 1024,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });
  });
});