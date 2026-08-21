import * as Schema from "effect/Schema";

const makeId = <Brand extends string>(brand: Brand) =>
  Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand(brand));

export const ConnectionId = makeId("ConnectionId");
export type ConnectionId = typeof ConnectionId.Type;
export const ThreadId = makeId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const QueryId = makeId("QueryId");
export type QueryId = typeof QueryId.Type;
export const MessageId = makeId("MessageId");
export type MessageId = typeof MessageId.Type;
export const ApprovalId = makeId("ApprovalId");
export type ApprovalId = typeof ApprovalId.Type;
export const ToolCallId = makeId("ToolCallId");
export type ToolCallId = typeof ToolCallId.Type;
export const RunId = makeId("RunId");
export type RunId = typeof RunId.Type;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;
