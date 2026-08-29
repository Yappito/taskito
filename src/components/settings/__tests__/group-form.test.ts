import { describe, it, expect } from "vitest";
import {
  emptyGroup,
  projectRoleFor,
  setProjectAccessRole,
  type ProjectAccessRole,
} from "../group-form";

const access: Array<{ projectId: string; role: ProjectAccessRole }> = [
  { projectId: "p1", role: "viewer" },
];

describe("setProjectAccessRole", () => {
  it("adds a project that has no entry", () => {
    expect(setProjectAccessRole(access, "p2", "manager")).toEqual([
      { projectId: "p1", role: "viewer" },
      { projectId: "p2", role: "manager" },
    ]);
  });

  it("updates the role of an existing entry", () => {
    expect(setProjectAccessRole(access, "p1", "owner")).toEqual([
      { projectId: "p1", role: "owner" },
    ]);
  });

  it("removes the entry when role is none", () => {
    expect(setProjectAccessRole(access, "p1", "none")).toEqual([]);
  });

  it("removing a missing project is a no-op", () => {
    expect(setProjectAccessRole(access, "pX", "none")).toEqual(access);
  });

  it("does not mutate the input array", () => {
    setProjectAccessRole(access, "p1", "owner");
    expect(access).toEqual([{ projectId: "p1", role: "viewer" }]);
  });
});

describe("projectRoleFor", () => {
  it("returns the configured role", () => {
    expect(projectRoleFor(access, "p1")).toBe("viewer");
  });

  it("returns none for unconfigured projects", () => {
    expect(projectRoleFor(access, "p2")).toBe("none");
    expect(projectRoleFor(emptyGroup.projectAccess, "p1")).toBe("none");
  });
});
