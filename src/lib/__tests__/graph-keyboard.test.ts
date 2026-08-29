import { describe, it, expect } from "vitest";
import { getGraphFocusOrder, getNextGraphFocusId } from "@/lib/graph-keyboard";

describe("getGraphFocusOrder", () => {
  it("orders nodes by x then y", () => {
    const order = getGraphFocusOrder([
      { id: "c", x: 200, y: 0 },
      { id: "a", x: 0, y: 100 },
      { id: "b", x: 0, y: 0 },
    ]);
    expect(order).toEqual(["b", "a", "c"]);
  });

  it("breaks exact position ties deterministically by id", () => {
    const order = getGraphFocusOrder([
      { id: "z", x: 10, y: 10 },
      { id: "a", x: 10, y: 10 },
    ]);
    expect(order).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const nodes = [
      { id: "b", x: 5, y: 0 },
      { id: "a", x: 0, y: 0 },
    ];
    getGraphFocusOrder(nodes);
    expect(nodes.map((node) => node.id)).toEqual(["b", "a"]);
  });

  it("returns an empty array for an empty graph", () => {
    expect(getGraphFocusOrder([])).toEqual([]);
  });
});

describe("getNextGraphFocusId", () => {
  const order = ["a", "b", "c"];

  it("moves forward and backward without wrapping by default", () => {
    expect(getNextGraphFocusId(order, "a", 1, false)).toBe("b");
    expect(getNextGraphFocusId(order, "b", -1, false)).toBe("a");
  });

  it("stays put at the edges when wrap is disabled", () => {
    expect(getNextGraphFocusId(order, "c", 1, false)).toBeNull();
    expect(getNextGraphFocusId(order, "a", -1, false)).toBeNull();
  });

  it("wraps around when requested", () => {
    expect(getNextGraphFocusId(order, "c", 1, true)).toBe("a");
    expect(getNextGraphFocusId(order, "a", -1, true)).toBe("c");
  });

  it("lands on the first/last node for an unknown current id", () => {
    expect(getNextGraphFocusId(order, "missing", 1, false)).toBe("a");
    expect(getNextGraphFocusId(order, "missing", -1, false)).toBe("c");
  });

  it("returns null for an empty order", () => {
    expect(getNextGraphFocusId([], "a", 1, true)).toBeNull();
  });
});
