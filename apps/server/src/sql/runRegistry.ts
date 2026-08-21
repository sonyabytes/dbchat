/**
 * Tracks the fibers of in-flight `sql.run` calls so `sql.cancel` can interrupt
 * them. Interrupting the fiber tears down the driver's row stream, and the
 * stream's finalizer is what actually cancels the query on the server
 * (`pg_cancel_backend` / `KILL QUERY` / sqlite interrupt) - see
 * `Services/DriverRegistry.ts`: "Interruption of `query` = cancel".
 *
 * Several runs can share a runId (see `deriveRunId`), so each id maps to a
 * stack of fibers and `cancel` interrupts the most recent one.
 */
import { NotFound, type RunId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/** Fiber of a run, with its success/error types erased. */
export type RunFiber = Fiber.Fiber<unknown, unknown>;

export interface RunRegistry {
  /** Push a fiber onto the stack for `runId`. */
  readonly register: (runId: RunId, fiber: RunFiber) => Effect.Effect<void>;
  /** Remove a specific fiber; safe to call twice (e.g. after a cancel). */
  readonly unregister: (runId: RunId, fiber: RunFiber) => Effect.Effect<void>;
  /** Interrupt the most recent run for `runId`; fails `NotFound` when idle. */
  readonly cancel: (runId: RunId) => Effect.Effect<void, NotFound>;
  /** Number of live runs for `runId` (tests/diagnostics). */
  readonly count: (runId: RunId) => number;
  /** Total number of live runs (tests/diagnostics). */
  readonly size: () => number;
}

export const makeRunRegistry = (): RunRegistry => {
  const running = new Map<RunId, Array<RunFiber>>();

  const drop = (runId: RunId, fiber: RunFiber) => {
    const stack = running.get(runId);
    if (!stack) return;
    const idx = stack.lastIndexOf(fiber);
    if (idx >= 0) stack.splice(idx, 1);
    if (stack.length === 0) running.delete(runId);
  };

  return {
    register: (runId, fiber) =>
      Effect.sync(() => {
        const stack = running.get(runId);
        if (stack) stack.push(fiber);
        else running.set(runId, [fiber]);
      }),
    unregister: (runId, fiber) => Effect.sync(() => drop(runId, fiber)),
    cancel: (runId) =>
      Effect.suspend(() => {
        const stack = running.get(runId);
        const fiber = stack?.pop();
        if (!fiber) return Effect.fail(new NotFound({ entity: "run", id: runId }));
        if (stack && stack.length === 0) running.delete(runId);
        // `Fiber.interrupt` waits for the fiber to finish unwinding, so when
        // `sql.cancel` returns the driver-side cancel has already run.
        return Fiber.interrupt(fiber);
      }),
    count: (runId) => running.get(runId)?.length ?? 0,
    size: () => {
      let total = 0;
      for (const stack of running.values()) total += stack.length;
      return total;
    },
  };
};
