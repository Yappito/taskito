import { describe, it, expect } from "vitest";
import { toggleId } from "../id-list";

describe("toggleId", () => {
  it("adds an id that is not present", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
  });

  it("adds to an empty list", () => {
    expect(toggleId([], "a")).toEqual(["a"]);
  });

  it("removes an id that is present", () => {
    expect(toggleId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("does not mutate the input array", () => {
    const ids = ["a", "b"];
    const next = toggleId(ids, "c");
    expect(ids).toEqual(["a", "b"]);
    expect(next).not.toBe(ids);
  });

  it("removing the last id yields an empty array", () => {
    expect(toggleId(["a"], "a")).toEqual([]);
  });

  it("toggling twice restores the original list", () => {
    const original = ["a", "b"];
    expect(toggleId(toggleId(original, "c"), "c")).toEqual(original);
  });
});
