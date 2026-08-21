/** Global conversation RPC helpers. Database and Git context is attached per thread. */
import { type ApprovalId, RPC, type SourceRef, type ThreadId } from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const threadListKey = ["chat.threads.list"] as const;

export const threadListQuery = queryOptions({
  queryKey: threadListKey,
  queryFn: () => callRpc((client) => client[RPC.chatThreadsList]()),
});

export const createThread = (title?: string, sources?: ReadonlyArray<SourceRef>) =>
  callRpc((client) => client[RPC.chatThreadsCreate]({
    ...(title ? { title } : {}),
    ...(sources ? { sources } : {}),
  }));

export const setThreadSources = (threadId: string, sources: ReadonlyArray<SourceRef>) =>
  callRpc((client) => client[RPC.chatThreadSourcesSet]({ threadId: threadId as ThreadId, sources }));

export const deleteThread = (threadId: string) =>
  callRpc((client) => client[RPC.chatThreadsDelete]({ threadId: threadId as ThreadId }));

export const resolveApproval = (approvalId: ApprovalId, approve: boolean) =>
  callRpc((client) => client[RPC.chatApprovalResolve]({ approvalId, approve }));

export const abortTurn = (threadId: string) => callRpc((client) => client[RPC.chatAbort]({ threadId: threadId as ThreadId }));
