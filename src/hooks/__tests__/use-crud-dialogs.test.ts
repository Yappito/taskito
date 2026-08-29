import { describe, it, expect } from "vitest";
import {
  crudDialogsReducer,
  createInitialCrudDialogsState,
  type CrudDialogsAction,
  type CrudDialogsState,
} from "../use-crud-dialogs";

interface Entity {
  id: string;
  name: string;
}

const empty = { createForm: { name: "" }, editForm: { name: "", role: "member" } };
type State = CrudDialogsState<Entity, { name: string }, { name: string; role: string }>;

type Action = CrudDialogsAction<Entity, { name: string }, { name: string; role: string }>;

function run(state: State, action: Action): State {
  return crudDialogsReducer(state, action, empty);
}

const initialState = createInitialCrudDialogsState<Entity, { name: string }, { name: string; role: string }>(empty);

describe("crudDialogsReducer", () => {
  it("starts fully closed with the empty forms", () => {
    expect(initialState).toEqual({
      createOpen: false,
      editOpen: false,
      createForm: { name: "" },
      editForm: { name: "", role: "member" },
      editing: null,
    });
  });

  it("openCreate opens the create dialog without touching forms", () => {
    const next = run(initialState, { type: "openCreate" });
    expect(next.createOpen).toBe(true);
    expect(next.createForm).toEqual({ name: "" });
    expect(next.editOpen).toBe(false);
  });

  it("closeCreate cancels but keeps typed values", () => {
    const typed = run(initialState, { type: "setCreateForm", form: { name: "typed" } });
    const closed = run({ ...typed, createOpen: true }, { type: "closeCreate" });
    expect(closed.createOpen).toBe(false);
    expect(closed.createForm).toEqual({ name: "typed" });
  });

  it("completeCreate closes and resets the create form", () => {
    const typed = run(initialState, { type: "setCreateForm", form: { name: "typed" } });
    const done = run({ ...typed, createOpen: true }, { type: "completeCreate" });
    expect(done.createOpen).toBe(false);
    expect(done.createForm).toEqual({ name: "" });
  });

  it("openEdit stores the entity and edit form", () => {
    const entity = { id: "e1", name: "Row" };
    const next = run(initialState, { type: "openEdit", entity, editForm: { name: "Row", role: "admin" } });
    expect(next.editOpen).toBe(true);
    expect(next.editing).toEqual(entity);
    expect(next.editForm).toEqual({ name: "Row", role: "admin" });
  });

  it("closeEdit cancels but keeps typed values and the entity", () => {
    const entity = { id: "e1", name: "Row" };
    const opened = run(initialState, { type: "openEdit", entity, editForm: { name: "Row", role: "member" } });
    const edited = run(opened, { type: "setEditForm", editForm: { name: "Changed", role: "member" } });
    const closed = run(edited, { type: "closeEdit" });
    expect(closed.editOpen).toBe(false);
    expect(closed.editing).toEqual(entity);
    expect(closed.editForm).toEqual({ name: "Changed", role: "member" });
  });

  it("completeEdit closes, clears the entity and resets the edit form", () => {
    const opened = run(initialState, {
      type: "openEdit",
      entity: { id: "e1", name: "Row" },
      editForm: { name: "Row", role: "admin" },
    });
    const done = run(opened, { type: "completeEdit" });
    expect(done.editOpen).toBe(false);
    expect(done.editing).toBeNull();
    expect(done.editForm).toEqual({ name: "", role: "member" });
  });

  it("closeAll closes both dialogs without resetting forms", () => {
    const open = run(
      run(initialState, { type: "openCreate" }),
      { type: "openEdit", entity: { id: "e1", name: "Row" }, editForm: { name: "x", role: "admin" } }
    );
    const closed = run(open, { type: "closeAll" });
    expect(closed.createOpen).toBe(false);
    expect(closed.editOpen).toBe(false);
    expect(closed.editForm).toEqual({ name: "x", role: "admin" });
  });

  it("setCreateForm/setEditForm support updater functions", () => {
    const typed = run(initialState, { type: "setCreateForm", form: (current) => ({ name: `${current.name}!` }) });
    expect(typed.createForm).toEqual({ name: "!" });
    const edited = run(typed, { type: "setEditForm", editForm: (current) => ({ ...current, role: "admin" }) });
    expect(edited.editForm).toEqual({ name: "", role: "admin" });
  });
});
