"use client";

import { useReducer } from "react";

/**
 * Shared state machine for the repeated admin CRUD pattern: a create dialog,
 * an edit dialog, the two form states and the entity currently being edited.
 * The reducer is pure so it can be unit-tested without a renderer.
 */

export interface CrudDialogsState<TEntity, TCreateForm, TEditForm> {
  createOpen: boolean;
  editOpen: boolean;
  createForm: TCreateForm;
  editForm: TEditForm;
  editing: TEntity | null;
}

/** New value for a form field set: either the value itself or an updater */
export type FormUpdate<T> = T | ((current: T) => T);

export type CrudDialogsAction<TEntity, TCreateForm, TEditForm> =
  | { type: "openCreate" }
  | { type: "closeCreate" }
  | { type: "completeCreate" }
  | { type: "openEdit"; entity: TEntity; editForm: TEditForm }
  | { type: "closeEdit" }
  | { type: "completeEdit" }
  | { type: "closeAll" }
  | { type: "setCreateForm"; form: FormUpdate<TCreateForm> }
  | { type: "setEditForm"; editForm: FormUpdate<TEditForm> };

export interface CrudDialogsEmpty<TCreateForm, TEditForm> {
  createForm: TCreateForm;
  editForm: TEditForm;
}

function resolveUpdate<T>(update: FormUpdate<T>, current: T): T {
  return typeof update === "function" ? (update as (current: T) => T)(current) : update;
}

export function createInitialCrudDialogsState<TEntity, TCreateForm, TEditForm>(
  empty: CrudDialogsEmpty<TCreateForm, TEditForm>
): CrudDialogsState<TEntity, TCreateForm, TEditForm> {
  return {
    createOpen: false,
    editOpen: false,
    createForm: empty.createForm,
    editForm: empty.editForm,
    editing: null,
  };
}

/**
 * Pure reducer behind useCrudDialogs.
 *
 * - closeCreate/closeEdit cancel a dialog, keeping any typed values (matches
 *   the original Cancel buttons).
 * - completeCreate/completeEdit close after a successful mutation and reset
 *   the form state (matches the original onSuccess handlers).
 * - closeAll closes both dialogs without resetting (shared Cancel buttons).
 */
export function crudDialogsReducer<TEntity, TCreateForm, TEditForm>(
  state: CrudDialogsState<TEntity, TCreateForm, TEditForm>,
  action: CrudDialogsAction<TEntity, TCreateForm, TEditForm>,
  empty: CrudDialogsEmpty<TCreateForm, TEditForm>
): CrudDialogsState<TEntity, TCreateForm, TEditForm> {
  switch (action.type) {
    case "openCreate":
      return { ...state, createOpen: true };
    case "closeCreate":
      return { ...state, createOpen: false };
    case "completeCreate":
      return { ...state, createOpen: false, createForm: empty.createForm };
    case "openEdit":
      return { ...state, editOpen: true, editing: action.entity, editForm: action.editForm };
    case "closeEdit":
      return { ...state, editOpen: false };
    case "completeEdit":
      return { ...state, editOpen: false, editing: null, editForm: empty.editForm };
    case "closeAll":
      return { ...state, createOpen: false, editOpen: false };
    case "setCreateForm":
      return { ...state, createForm: resolveUpdate(action.form, state.createForm) };
    case "setEditForm":
      return { ...state, editForm: resolveUpdate(action.editForm, state.editForm) };
    default:
      return state;
  }
}

export interface CrudDialogsApi<TEntity, TCreateForm, TEditForm>
  extends CrudDialogsState<TEntity, TCreateForm, TEditForm> {
  openCreate: () => void;
  /** Cancel-style close: keeps typed values */
  closeCreate: () => void;
  /** Success-style close: closes and resets the create form */
  completeCreate: () => void;
  openEdit: (entity: TEntity, editForm: TEditForm) => void;
  /** Cancel-style close: keeps typed values */
  closeEdit: () => void;
  /** Success-style close: closes, clears the edited entity and resets the form */
  completeEdit: () => void;
  /** Closes both dialogs without resetting (shared Cancel buttons) */
  closeAll: () => void;
  setCreateForm: (form: FormUpdate<TCreateForm>) => void;
  setEditForm: (editForm: FormUpdate<TEditForm>) => void;
}

/** Hook version of the create/edit dialog state quintuple used by admin CRUD screens */
export function useCrudDialogs<TEntity, TCreateForm, TEditForm = TCreateForm>(
  empty: CrudDialogsEmpty<TCreateForm, TEditForm>
): CrudDialogsApi<TEntity, TCreateForm, TEditForm> {
  const [state, dispatch] = useReducer(
    (current: CrudDialogsState<TEntity, TCreateForm, TEditForm>, action: CrudDialogsAction<TEntity, TCreateForm, TEditForm>) =>
      crudDialogsReducer(current, action, empty),
    empty,
    createInitialCrudDialogsState
  );

  return {
    ...state,
    openCreate: () => dispatch({ type: "openCreate" }),
    closeCreate: () => dispatch({ type: "closeCreate" }),
    completeCreate: () => dispatch({ type: "completeCreate" }),
    openEdit: (entity, editForm) => dispatch({ type: "openEdit", entity, editForm }),
    closeEdit: () => dispatch({ type: "closeEdit" }),
    completeEdit: () => dispatch({ type: "completeEdit" }),
    closeAll: () => dispatch({ type: "closeAll" }),
    setCreateForm: (form) => dispatch({ type: "setCreateForm", form }),
    setEditForm: (editForm) => dispatch({ type: "setEditForm", editForm }),
  };
}
