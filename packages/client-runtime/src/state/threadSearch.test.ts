import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  threadSearchContextTerms,
  threadSearchMatchKey,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("creates stable keys regardless of environment order", () => {
  expect(makeThreadSearchKey([envB, envA], "needle")).toBe(
    makeThreadSearchKey([envA, envB], "needle"),
  );
});

it("creates keys without array methods unavailable in Hermes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");

  try {
    expect(makeThreadSearchKey([envB, envA], "needle")).toBe('[["env-a","env-b"],"needle"]');
  } finally {
    if (descriptor !== undefined) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
});

it("encodes scoped thread keys without delimiter collisions", () => {
  const first = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env\u0000thread"),
    threadId: ThreadId.make("id"),
  });
  const second = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread\u0000id"),
  });

  expect(first).not.toBe(second);
});

it("accepts search keys at the maximum decoded query length", () => {
  const queries: string[] = [];
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (_environmentId, query) => {
      queries.push(query);
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();
  const query = "a".repeat(200);

  try {
    registry.get(searchAtom(makeThreadSearchKey([envA], query)));
    registry.get(searchAtom(makeThreadSearchKey([envA], ` ${query} `)));

    expect(queries).toEqual([query, query]);
  } finally {
    registry.dispose();
  }
});

it("ignores invalid search keys", () => {
  let searchCount = 0;
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: () => {
      searchCount += 1;
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  try {
    const state = registry.get(searchAtom(makeThreadSearchKey([envA], "a".repeat(201))));
    const malformedState = registry.get(searchAtom("not json{{"));

    expect(state).toEqual({ matches: [], isLoading: false, failed: false });
    expect(malformedState).toEqual({ matches: [], isLoading: false, failed: false });
    expect(searchCount).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("merges successful environments and silently ignores failures", () => {
  const result: OrchestrationSearchThreadsResult = {
    matches: [
      {
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user",
        snippet: "needle",
        messageCreatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (environmentId) =>
      environmentId === envA
        ? Atom.make(AsyncResult.success(result))
        : Atom.make(
            AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
              Cause.fail(new Error("unsupported rpc")),
            ),
          ),
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  const state = registry.get(searchAtom(makeThreadSearchKey([envB, envA], "needle")));
  expect(state).toEqual({
    matches: [{ ...result.matches[0], environmentId: envA }],
    isLoading: false,
    failed: false,
  });
  expect(registry.get(searchAtom(makeThreadSearchKey([envB], "needle")))).toEqual({
    matches: [],
    isLoading: false,
    failed: true,
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});

it("cancels the old search when its last UI subscriber leaves", async () => {
  let entered!: () => void;
  let canceled!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  const request = Atom.make(
    Effect.callback<OrchestrationSearchThreadsResult>(() => {
      entered();
      return Effect.sync(canceled);
    }),
  ).pipe(Atom.setIdleTTL(0));
  const family = createThreadSearchResultsAtomFamily({
    getSearchAtom: () => request,
    labelPrefix: "cancel-test",
  });
  const registry = AtomRegistry.make();
  try {
    const unmount = registry.mount(family(makeThreadSearchKey([envA], "old query")));
    await started;
    unmount();
    await finished;
    expect(true).toBe(true);
  } finally {
    registry.dispose();
  }
});

it("appends another page without replacing earlier results or duplicating chats", () => {
  const match = (id: string) => ({
    threadId: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    source: "user" as const,
    snippet: "needle",
    messageCreatedAt: null,
  });
  const first = Atom.make(
    AsyncResult.success<OrchestrationSearchThreadsResult>({
      matches: [match("new")],
      nextCursor: { words: { before: 100 } },
    }),
  );
  const more = Atom.make<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, never>>(
    AsyncResult.initial(true),
  ).pipe(Atom.setIdleTTL(0));
  const family = createThreadSearchResultsAtomFamily({
    getSearchAtom: (_environmentId, _query, cursor) => (cursor ? more : first),
    labelPrefix: "test:search-pages",
  });
  const registry = AtomRegistry.make();
  try {
    const result = family(makeThreadSearchKey([envA], "needle"));
    const unmount = registry.mount(result);
    const ids = () => registry.get(result).matches.map((hit) => hit.threadId);
    const paginate = registry.get(result).pagination?.loadMore;
    expect(paginate).toBeDefined();
    paginate?.();
    expect(registry.get(result).pagination?.isLoading).toBe(true);
    expect(ids()).toEqual(["new"]);
    registry.set(more, AsyncResult.success({ matches: [match("new"), match("old")] }));
    expect(ids()).toEqual(["new", "old"]);
    expect(registry.get(result).pagination).toBeUndefined();
    paginate?.();
    expect(ids()).toEqual(["new", "old"]);
    unmount();
  } finally {
    registry.dispose();
  }
});

it("orders about matches and passing mentions across environments and later pages", () => {
  const hit = (id: string, about: boolean, activityAt: string) => ({
    threadId: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    source: "user" as const,
    snippet: "BetterWright",
    messageCreatedAt: null,
    about,
    activityAt,
  });
  const archivePage = {
    names: { score: 1, archived: 0, updatedAt: "", threadId: ThreadId.make("old-title") },
  };
  const envOld = Atom.make(
    AsyncResult.success<OrchestrationSearchThreadsResult>({
      matches: [hit("old-title", true, "2026-10-20T12:00:00.000Z")],
      nextCursor: archivePage,
    }),
  );
  const envRecent = Atom.make(
    AsyncResult.success<OrchestrationSearchThreadsResult>({
      matches: [
        hit("wanted", true, "2026-11-25T12:00:00.000Z"),
        hit("fifteen-minutes", false, "2026-11-27T11:45:00.000Z"),
      ],
    }),
  );
  const more = Atom.make(
    AsyncResult.success<OrchestrationSearchThreadsResult>({
      matches: [hit("nine-minutes", false, "2026-11-27T11:51:00.000Z")],
    }),
  );
  const family = createThreadSearchResultsAtomFamily({
    getSearchAtom: (id, _query, cursor) => (cursor ? more : id === envA ? envOld : envRecent),
    labelPrefix: "test:search-tiers",
  });
  const registry = AtomRegistry.make();
  try {
    const search = family(makeThreadSearchKey([envA, envB], "betterwright"));
    const unmount = registry.mount(search);
    const ids = () => registry.get(search).matches.map((match) => match.threadId);
    expect(ids()).toEqual(["wanted", "old-title", "fifteen-minutes"]);
    registry.get(search).pagination?.loadMore();
    expect(ids()).toEqual(["wanted", "old-title", "nine-minutes", "fifteen-minutes"]);
    unmount();
  } finally {
    registry.dispose();
  }
});

it("uses scratch folder words, and project names only for a real repository", () => {
  const scratch = { title: "No project", workspaceRoot: "/Users/me/.t3/scratch" };
  expect(
    threadSearchContextTerms(
      {
        title: "Review Pi Prompt Parts Change",
        worktreePath: "/Users/me/.t3/scratch/2026-11-25-https-github-com-betterwright-c44ee162",
      },
      scratch,
    ),
  ).toEqual(["Review Pi Prompt Parts Change", "https-github-com-betterwright"]);
  expect(
    threadSearchContextTerms(
      {
        title: "Fix search",
        worktreePath: "/Users/me/code/app-worktrees/search-order",
        branch: "t3/search",
      },
      {
        title: "sshcode",
        workspaceRoot: "/Users/me/code/sshcode",
        repositoryIdentity: {
          canonicalKey: "github.com/sshdotcodes/sshcode",
          displayName: "sshcode",
        },
      } as Parameters<typeof threadSearchContextTerms>[1],
    ),
  ).toEqual([
    "Fix search",
    "search-order",
    "t3/search",
    "sshcode",
    "sshcode",
    "github.com/sshdotcodes/sshcode",
    "sshcode",
  ]);
});
