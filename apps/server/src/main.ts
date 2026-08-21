import { DbchatRpcs } from "@dbchat/contracts";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { isOriginAllowed, ServerConfig, ServerConfigLive } from "./config.ts";
import { AgentServiceLive } from "./Layers/AgentServiceLive.ts";
import { ConnectionStoreLive } from "./Layers/ConnectionStoreLive.ts";
import { DriverRegistryLive } from "./Layers/DriverRegistryLive.ts";
import { PersistenceLive } from "./persistence/Persistence.ts";
import { RpcHandlersLive } from "./rpc/index.ts";

/* ---- swap these lines to replace a stub with a real implementation ---- */
const ConnectionStoreLayer = ConnectionStoreLive;
const DriverRegistryLayer = DriverRegistryLive;
const AgentServiceLayer = AgentServiceLive.pipe(Layer.provide(DriverRegistryLayer));
/* ----------------------------------------------------------------------- */

const ServicesLive = Layer.mergeAll(AgentServiceLayer, DriverRegistryLayer).pipe(
  Layer.provideMerge(ConnectionStoreLayer),
  Layer.provideMerge(PersistenceLive),
  Layer.provideMerge(ServerConfigLive),
);

const RpcLayer = RpcHandlersLive.pipe(Layer.provideMerge(RpcSerialization.layerJson));

const HealthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.gen(function* () {
    const { version } = yield* ServerConfig;
    return HttpServerResponse.jsonUnsafe({ ok: true, version });
  }),
);

const RpcRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const handler = yield* RpcServer.toHttpEffectWebsocket(DbchatRpcs);
    const { allowedOrigins } = yield* ServerConfig;
    // Origin gate for the upgrade: see `isOriginAllowed` in config.ts.
    const guarded = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = request.headers["origin"];
      if (!isOriginAllowed(origin, allowedOrigins)) {
        yield* Effect.logWarning("rejected /rpc upgrade from disallowed origin", { origin });
        return HttpServerResponse.text("Forbidden: origin not allowed", { status: 403 });
      }
      return yield* handler;
    });
    yield* router.add("GET", "/rpc", guarded);
  }),
).pipe(Layer.provide(RpcLayer));

const CorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { allowedOrigins } = yield* ServerConfig;
    return HttpRouter.cors({
      allowedOrigins: [...allowedOrigins],
      allowedMethods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
      credentials: true,
    });
  }),
);

const RoutesLive = Layer.mergeAll(HealthRoute, RpcRoute, CorsLayer);

const HttpLive = Layer.unwrap(
  Effect.gen(function* () {
    const { port, host } = yield* ServerConfig;
    yield* Effect.logInfo(`dbchat server listening on http://${host}:${port} (rpc: ws://${host}:${port}/rpc)`);
    return BunHttpServer.layer({ port, hostname: host });
  }),
);

const MainLive = HttpRouter.serve(RoutesLive, { disableLogger: true }).pipe(
  Layer.provide(HttpLive),
  Layer.provideMerge(ServicesLive),
);

BunRuntime.runMain(Layer.launch(MainLive));
