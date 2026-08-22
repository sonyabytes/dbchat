import {
  DbchatRpcs,
  type GitHubRepositoryInput,
  type GitRepository,
  RPC,
  type RepositoryId,
  ValidationError,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { inspectGitInput, inspectGitRepository } from "../agent/git.ts";
import { type FetchError, removeMirror, repositoryDir, syncRemote } from "../agent/gitFetcher.ts";
import { parseGitHubUrl, probeGitHub, probeToValidation } from "../agent/github.ts";
import { type GitRepositorySync, newId } from "../agent/repo.ts";
import { ServerConfig } from "../config.ts";
import { SecretCipher, SecretCipherLive } from "../db/secrets.ts";
import { ChatRepo } from "../Layers/AgentServiceLive.ts";

const fetchToValidation = (error: FetchError): ValidationError =>
  new ValidationError({ field: error.status === "unauthorized" ? "token" : "remoteUrl", message: error.message });

export const gitHandlers = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  const cipher = yield* SecretCipher;
  const { homeDir } = yield* ServerConfig;

  const storeToken = (id: RepositoryId, token: string | undefined) =>
    repo.setGitRepositorySecret(id, token ? cipher.encrypt({ password: token }) : undefined);

  const loadToken = (id: RepositoryId) =>
    repo.getGitRepositorySecret(id).pipe(Effect.map((enc) => (enc ? cipher.decrypt(enc).password : undefined)));

  /**
   * Fetch the remote and pin the head. A failed fetch keeps the previous pin
   * (the agent can still read the last good commit) but records why the
   * remote is unreachable so the UI can show it.
   */
  const syncGitHub = (repository: GitRepository, token: string | undefined, branch: string | undefined) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        syncRemote({
          dir: repository.path,
          remoteUrl: repository.remoteUrl!,
          ...(branch ? { branch } : {}),
          ...(token ? { token } : {}),
        }),
      );
      const fetchedAt = new Date().toISOString();
      const sync: GitRepositorySync = result._tag === "Success"
        ? { head: result.success, status: "connected", fetchedAt }
        : { status: result.failure.status, statusMessage: result.failure.message };
      const updated = yield* repo.updateGitRepositorySync(repository.id, sync).pipe(Effect.orDie);
      return { updated, error: result._tag === "Failure" ? result.failure : undefined };
    });

  const createGitHub = (input: GitHubRepositoryInput) =>
    Effect.gen(function* () {
      const ref = parseGitHubUrl(input.remoteUrl);
      if (!ref) {
        return yield* new ValidationError({ field: "remoteUrl", message: "Enter a GitHub URL or owner/repo." });
      }
      const token = input.token?.trim() || undefined;
      // Probe first: a bad token or typo fails in one HTTP round-trip instead of a clone attempt.
      const probe = yield* probeGitHub(ref, token).pipe(Effect.mapError(probeToValidation));
      const id = newId("repo") as RepositoryId;
      const now = new Date().toISOString();
      const repository: GitRepository = {
        id,
        name: input.name.trim() || `${ref.owner}/${ref.repo}`,
        origin: "github",
        path: repositoryDir(homeDir, id),
        remoteUrl: ref.remoteUrl,
        branch: input.branch?.trim() || probe.defaultBranch,
        headCommit: "",
        status: "connected",
        hasToken: token !== undefined,
        createdAt: now,
        updatedAt: now,
      };
      yield* repo.insertGitRepository(repository);
      yield* storeToken(id, token);
      const { updated, error } = yield* syncGitHub(repository, token, repository.branch);
      if (error) {
        // Nothing usable was pinned; don't leave a half-connected source behind.
        yield* repo.deleteGitRepository(id).pipe(Effect.orDie);
        removeMirror(repository.path);
        return yield* fetchToValidation(error);
      }
      return { repository: updated, models: inspectGitRepository(updated) };
    });

  return {
    [RPC.gitRepositoriesList]: () => repo.listGitRepositories(),
    [RPC.gitRepositoriesCreate]: (input) =>
      input.origin === "github"
        ? createGitHub(input)
        : Effect.gen(function* () {
          const inspected = yield* inspectGitInput(input);
          const now = new Date().toISOString();
          const repository: GitRepository = {
            id: newId("repo") as RepositoryId,
            origin: "local",
            status: "connected",
            hasToken: false,
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
        if (current.origin === "github") {
          const token = yield* loadToken(id);
          const { updated, error } = yield* syncGitHub(current, token, current.branch);
          if (error) return yield* fetchToValidation(error);
          return { repository: updated, models: inspectGitRepository(updated) };
        }
        const inspected = yield* inspectGitInput({ name: current.name, path: current.path, branch: current.branch });
        const repository = yield* repo.updateGitRepositorySync(id, {
          head: { branch: inspected.branch, headCommit: inspected.headCommit },
          status: "connected",
        });
        return { repository, models: inspectGitRepository(repository) };
      }),
    [RPC.gitRepositoriesDelete]: ({ id }) =>
      Effect.gen(function* () {
        const current = yield* repo.getGitRepository(id);
        yield* repo.deleteGitRepository(id);
        if (current.origin === "github") removeMirror(current.path);
      }),
    [RPC.gitGithubTest]: (input) =>
      Effect.gen(function* () {
        const ref = parseGitHubUrl(input.remoteUrl);
        if (!ref) {
          return yield* new ValidationError({ field: "remoteUrl", message: "Enter a GitHub URL or owner/repo." });
        }
        return yield* probeGitHub(ref, input.token?.trim() || undefined).pipe(Effect.mapError(probeToValidation));
      }),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
}).pipe(Effect.provide(SecretCipherLive));
