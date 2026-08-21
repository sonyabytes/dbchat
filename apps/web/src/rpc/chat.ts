/** chat.* RPC helpers (queries + one-shot calls). Streaming lives in `lib/chat-store.ts`. */
import { type ApprovalId, type ConnectionId, RPC, type ThreadId } from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const threadListKey = (connectionId: string) => ["chat.threads.list", connectionId] as const;

export const threadListQuery = (connectionId: string) =>
  queryOptions({
    queryKey: threadListKey(connectionId),
    queryFn: () => callRpc((c) => c[RPC.chatThreadsList]({ connectionId: connectionId as ConnectionId })),
    enabled: Boolean(connectionId),
  });

export const createThread = (connectionId: string, title?: string) =>
  callRpc((c) => c[RPC.chatThreadsCreate]({ connectionId: connectionId as ConnectionId, ...(title ? { title } : {}) }));

export const deleteThread = (threadId: string) =>
  callRpc((c) => c[RPC.chatThreadsDelete]({ threadId: threadId as ThreadId }));

export const resolveApproval = (approvalId: ApprovalId, approve: boolean) =>
  callRpc((c) => c[RPC.chatApprovalResolve]({ approvalId, approve }));

export const abortTurn = (threadId: string) => callRpc((c) => c[RPC.chatAbort]({ threadId: threadId as ThreadId }));
