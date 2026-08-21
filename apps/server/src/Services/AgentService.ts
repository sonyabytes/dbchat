import type {
  AgentError,
  ApprovalId,
  ChatEvent,
  ChatSendInput,
  NotFound,
  SqlError,
  SqlSuggestRequest,
  SqlSuggestResult,
  ThreadId,
  WriteBlocked,
} from "@dbchat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface AgentServiceShape {
  /** Run one turn; the stream completes when the turn is done. */
  readonly send: (input: ChatSendInput) => Stream.Stream<ChatEvent, NotFound | AgentError | WriteBlocked>;
  /** Live event feed for a thread (mirrors whatever `send` is emitting). */
  readonly events: (threadId: ThreadId) => Stream.Stream<ChatEvent, NotFound>;
  readonly abort: (threadId: ThreadId) => Effect.Effect<void, NotFound>;
  readonly resolveApproval: (
    approvalId: ApprovalId,
    approve: boolean,
  ) => Effect.Effect<void, NotFound | SqlError | WriteBlocked>;
  readonly suggest: (req: SqlSuggestRequest) => Effect.Effect<SqlSuggestResult, AgentError>;
}

export class AgentService extends Context.Service<AgentService, AgentServiceShape>()(
  "dbchat/Services/AgentService",
) {}
