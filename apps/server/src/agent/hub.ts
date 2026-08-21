/** Per-thread fan-out of ChatEvents: `send` publishes, `events(threadId)` subscribes. */
import type { ChatEvent, ThreadId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface ChatHub {
  readonly publish: (threadId: ThreadId, event: ChatEvent) => Effect.Effect<void>;
  /** Live feed; never completes on its own (the subscriber ends it). */
  readonly subscribe: (threadId: ThreadId) => Stream.Stream<ChatEvent>;
  /**
   * Scoped subscription: the subscription exists as soon as this effect
   * returns, so events published afterwards are guaranteed to be seen.
   */
  readonly subscribeScoped: (threadId: ThreadId) => Effect.Effect<Stream.Stream<ChatEvent>, never, Scope.Scope>;
}

export const makeChatHub = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<{ threadId: ThreadId; event: ChatEvent }>();
  const hub: ChatHub = {
    publish: (threadId, event) => PubSub.publish(pubsub, { threadId, event }).pipe(Effect.asVoid),
    subscribe: (threadId) =>
      Stream.fromPubSub(pubsub).pipe(
        Stream.filter((e) => e.threadId === threadId),
        Stream.map((e) => e.event),
      ),
    subscribeScoped: (threadId) =>
      PubSub.subscribe(pubsub).pipe(
        Effect.map((sub) =>
          Stream.fromSubscription(sub).pipe(
            Stream.filter((e) => e.threadId === threadId),
            Stream.map((e) => e.event),
          ),
        ),
      ),
  };
  return hub;
});
