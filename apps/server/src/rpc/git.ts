import { DbchatRpcs, type GitRepository, RPC, type RepositoryId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { inspectGitInput, inspectGitRepository } from "../agent/git.ts";
import { newId } from "../agent/repo.ts";
import { ChatRepo } from "../Layers/AgentServiceLive.ts";

export const gitHandlers = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  return {
    [RPC.gitRepositoriesList]: () => repo.listGitRepositories(),
    [RPC.gitRepositoriesCreate]: (input) =>
      Effect.gen(function* () {
        const inspected = yield* inspectGitInput(input);
        const now = new Date().toISOString();
        const repository: GitRepository = {
          id: newId("repo") as RepositoryId,
          ...inspected,
          createdAt: now,
          updatedAt: now,
        };
        yield* repo.insertGitRepository(repository);
        return { repository, models: inspectGitRepository(repository) };
      }),
    [RPC.gitRepositoriesRefresh]: ({ id }) =>
      Effect.gen(function* () {
        const current = yield* repo.getGitRepository(id);
        const inspected = yield* inspectGitInput({ name: current.name, path: current.path, branch: current.branch });
        const repository = yield* repo.updateGitRepositoryHead(id, inspected.branch, inspected.headCommit);
        return { repository, models: inspectGitRepository(repository) };
      }),
    [RPC.gitRepositoriesDelete]: ({ id }) => repo.deleteGitRepository(id),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
