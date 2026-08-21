/** chat.* handlers: threads/messages from sqlite (ChatRepo), turns from AgentService. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { ChatRepo } from "../Layers/AgentServiceLive.ts";
import { AgentService } from "../Services/AgentService.ts";
import { ConnectionStore } from "../Services/ConnectionStore.ts";

export const chatHandlers = Effect.gen(function* () {
  const agent = yield* AgentService;
  const store = yield* ConnectionStore;
  const repo = yield* ChatRepo;

  return {
    [RPC.chatThreadsList]: ({ connectionId }) => repo.listThreads(connectionId),
    [RPC.chatThreadsCreate]: ({ connectionId, title }) =>
      store.get(connectionId).pipe(Effect.andThen(repo.createThread(connectionId, title ?? "New chat"))),
    [RPC.chatThreadsDelete]: ({ threadId }) => repo.deleteThread(threadId),
    [RPC.chatMessagesList]: ({ threadId }) => repo.getThread(threadId).pipe(Effect.andThen(repo.listMessages(threadId))),
    [RPC.chatSend]: (input) => agent.send(input),
    [RPC.chatAbort]: ({ threadId }) => agent.abort(threadId),
    [RPC.chatApprovalResolve]: ({ approvalId, approve }) => agent.resolveApproval(approvalId, approve),
    [RPC.chatEvents]: ({ threadId }) => agent.events(threadId),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
