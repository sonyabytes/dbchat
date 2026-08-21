import { expect, test } from "bun:test";

import type { RunId } from "@dbchat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { makeRunRegistry } from "./runRegistry.ts";

const runId = "run_1" as RunId;

test("cancel interrupts the registered fiber and clears the entry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = makeRunRegistry();
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const fiber = yield* Effect.forkChild(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(released, undefined)),
        ),
      );
      yield* registry.register(runId, fiber);
      yield* Deferred.await(started);
      expect(registry.count(runId)).toBe(1);

      yield* registry.cancel(runId);

      // `Fiber.interrupt` waits for unwinding, so the finalizer has already run.
      yield* Deferred.await(released);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(registry.size()).toBe(0);
    }),
  );
});

test("cancel fails NotFound when nothing is running", async () => {
  const exit = await Effect.runPromiseExit(makeRunRegistry().cancel(runId));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain("NotFound");
  }
});

test("cancel targets the most recent run for a shared runId", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = makeRunRegistry();
      const first = yield* Effect.forkChild(Effect.never);
      const second = yield* Effect.forkChild(Effect.never);
      yield* registry.register(runId, first);
      yield* registry.register(runId, second);
      expect(registry.count(runId)).toBe(2);

      yield* registry.cancel(runId);
      expect(Exit.hasInterrupts(yield* Fiber.await(second))).toBe(true);
      expect(registry.count(runId)).toBe(1);

      yield* registry.cancel(runId);
      expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true);
      expect(registry.size()).toBe(0);
    }),
  );
});

test("unregister is idempotent and only removes the given fiber", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = makeRunRegistry();
      const a = yield* Effect.forkChild(Effect.never);
      const b = yield* Effect.forkChild(Effect.never);
      yield* registry.register(runId, a);
      yield* registry.register(runId, b);

      yield* registry.unregister(runId, a);
      yield* registry.unregister(runId, a);
      expect(registry.count(runId)).toBe(1);

      yield* registry.cancel(runId);
      expect(Exit.hasInterrupts(yield* Fiber.await(b))).toBe(true);
      yield* Fiber.interrupt(a);
    }),
  );
});
