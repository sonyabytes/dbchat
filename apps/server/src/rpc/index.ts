/**
 * The ONLY place handler modules are merged into the RpcGroup layer.
 * Domain files (connection/schema/table/sql/chat/server) each export an Effect
 * yielding a partial handlers object; add a new domain by importing it here.
 */
import { DbchatRpcs } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { aiHandlers } from "./ai.ts";
import { chatHandlers } from "./chat.ts";
import { connectionHandlers } from "./connection.ts";
import { gitHandlers } from "./git.ts";
import { schemaHandlers } from "./schema.ts";
import { serverHandlers } from "./server.ts";
import { sqlHandlers } from "./sql.ts";
import { tableHandlers } from "./table.ts";

export const RpcHandlersLive = DbchatRpcs.toLayer(
  Effect.gen(function* () {
    return DbchatRpcs.of({
      ...(yield* serverHandlers),
      ...(yield* connectionHandlers),
      ...(yield* gitHandlers),
      ...(yield* schemaHandlers),
      ...(yield* tableHandlers),
      ...(yield* sqlHandlers),
      ...(yield* chatHandlers),
      ...(yield* aiHandlers),
    });
  }),
);
