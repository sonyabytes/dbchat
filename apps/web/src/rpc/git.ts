import { RPC, type GitHubConnectionTestInput, type GitRepositoryInput, type RepositoryId } from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const gitRepositoryKeys = {
  list: ["git.repositories.list"] as const,
};

export const gitRepositoryListQuery = queryOptions({
  queryKey: gitRepositoryKeys.list,
  queryFn: () => callRpc((client) => client[RPC.gitRepositoriesList]()),
});

export const gitRepositoryApi = {
  create: (input: GitRepositoryInput) => callRpc((client) => client[RPC.gitRepositoriesCreate](input)),
  refresh: (id: RepositoryId) => callRpc((client) => client[RPC.gitRepositoriesRefresh]({ id })),
  remove: (id: RepositoryId) => callRpc((client) => client[RPC.gitRepositoriesDelete]({ id })),
  testGitHub: (input: GitHubConnectionTestInput) => callRpc((client) => client[RPC.gitGithubTest](input)),
};
