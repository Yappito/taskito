import { vi } from "vitest";
import type { Mock } from "vitest";

/**
 * A single Prisma delegate (e.g. `prisma.task`) whose methods are Vitest mocks.
 * Any method accessed on a delegate becomes a `vi.fn()` automatically, so tests
 * can configure and assert on arbitrary model/method combinations without the
 * harness enumerating them up front.
 */
export type PrismaModelMock = Record<string, Mock>;

/**
 * Shared Prisma mock used by the router and authz test suites.
 *
 * - `prisma.<model>.<method>` resolves to a memoized `vi.fn()` by default.
 * - `prisma.$transaction(callback)` invokes the callback with the same mock,
 *   so `tx.<model>.<method>` resolves to the identical `vi.fn()`.
 * - `prisma.$transaction([...])` (batch form) resolves via `Promise.all`.
 * - `"someModel" in prisma` is always true (delegates are never missing).
 * - Assignments like `prisma.task.findMany = customFn` are supported: the
 *   set trap stores the override on the underlying delegate object.
 */
export type PrismaMock = Record<string, PrismaModelMock> & {
  /** Interactive / batch transactions run against this same mock. */
  $transaction: Mock;
};

const NON_DELEGATE_KEYS = new Set(["then", "catch", "finally"]);

function delegateFor(models: Map<string, PrismaModelMock>, model: string): PrismaModelMock {
  const existing = models.get(model);
  if (existing) {
    return existing;
  }

  const delegate: PrismaModelMock = new Proxy({} as PrismaModelMock, {
    get(target, method) {
      if (typeof method !== "string") {
        return undefined;
      }
      const memoized = target[method];
      if (memoized) {
        return memoized;
      }
      const mock = vi.fn().mockName(`prisma.${model}.${String(method)}`);
      target[method] = mock;
      return mock;
    },
  });
  models.set(model, delegate);
  return delegate;
}

/**
 * Creates a Proxy-based Prisma mock where every `prisma.<model>.<method>`
 * accessor is a fresh (memoized) Vitest mock. Tests configure behavior with
 * the usual mock APIs:
 *
 * ```ts
 * const prisma = createPrismaMock();
 * prisma.task.findUnique.mockResolvedValue({ id: "t1", projectId: "p1" });
 * ```
 */
export function createPrismaMock(): PrismaMock {
  const models = new Map<string, PrismaModelMock>();

  const transaction = vi.fn((input: unknown) => {
    if (Array.isArray(input)) {
      return Promise.all(input as Array<Promise<unknown>>);
    }
    const callback = input as (tx: unknown) => unknown;
    return callback(proxy);
  }).mockName("prisma.$transaction");

  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (typeof prop !== "string" || NON_DELEGATE_KEYS.has(prop)) {
        return undefined;
      }
      if (prop === "$transaction") {
        return transaction;
      }
      return delegateFor(models, prop);
    },
    has() {
      return true;
    },
    set(_target, prop, value) {
      if (typeof prop === "string" && !NON_DELEGATE_KEYS.has(prop)) {
        // Writes land on the underlying delegate target so a later read via
        // the memoizing get trap returns the override instead of a new mock.
        const delegate = delegateFor(models, prop) as Record<string, unknown>;
        delegate[prop] = value;
      }
      return true;
    },
  });

  return proxy as unknown as PrismaMock;
}