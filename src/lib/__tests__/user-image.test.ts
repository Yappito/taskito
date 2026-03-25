import { describe, expect, it } from "vitest";
import {
  getStoredProfileImageKey,
  getUserImageUrl,
  isStoredProfileImage,
  toStoredProfileImageValue,
} from "@/lib/user-image";

describe("user-image", () => {
  it("converts stored profile image tokens into authenticated URLs", () => {
    expect(getUserImageUrl("profile:abc-123.webp")).toBe("/api/profile-images/abc-123.webp");
    expect(getStoredProfileImageKey("profile:abc-123.webp")).toBe("abc-123.webp");
    expect(isStoredProfileImage("profile:abc-123.webp")).toBe(true);
  });

  it("preserves non-managed image URLs", () => {
    expect(getUserImageUrl("https://example.com/avatar.png")).toBe("https://example.com/avatar.png");
    expect(getStoredProfileImageKey("https://example.com/avatar.png")).toBeNull();
    expect(isStoredProfileImage("https://example.com/avatar.png")).toBe(false);
  });

  it("builds stored profile image values", () => {
    expect(toStoredProfileImageValue("avatar.jpg")).toBe("profile:avatar.jpg");
  });
});