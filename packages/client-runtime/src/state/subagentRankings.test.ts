import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  SubagentRankingsError,
  WS_METHODS,
  type AuthSessionState,
  type SubagentRankingsSnapshot,
  type SubagentRankingsThumbInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  canRateSubagent,
  createSubagentRankingsAtoms,
  modelRankingRunDetails,
  modelRankingRunEvidence,
} from "./subagentRankings.ts";
import { squashAtomCommandFailure } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const home = EnvironmentId.make("home");
const remote = EnvironmentId.make("remote");
const task = NodeId.make("task");
const provider = ProviderInstanceId.make("codex");
const models: SubagentRankingsSnapshot["models"] = [
  {
    instanceId: provider,
    model: "gpt-6.1",
    family: "gpt",
    yourRuns: "14 tasks, 86% done",
    byKind: [{ kind: "code", yourRuns: "10 tasks, 90% done" }],
  },
  {
    instanceId: ProviderInstanceId.make("other-account"),
    model: "gpt-6.1",
    family: "gpt",
    yourRuns: "2 tasks, 50% done",
    byKind: [{ kind: "research", yourRuns: "2 tasks, 50% done" }],
  },
  {
    instanceId: provider,
    model: "gpt-6.2",
    family: "gpt",
    yourRuns: "1 task, 100% done",
    byKind: [],
  },
  {
    instanceId: ProviderInstanceId.make("claude"),
    model: "opus",
    family: "claude",
    yourRuns: "4 tasks, 75% done",
    byKind: [],
  },
];

function grant(operate: boolean): AuthSessionState {
  return {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationReadScope],
    permissions: operate
      ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
      : [AuthOrchestrationReadScope],
  };
}

const harness = Effect.fn(function* (destination?: EnvironmentId) {
  const calls: Array<{ environmentId: EnvironmentId; input: SubagentRankingsThumbInput }> = [];
  type Source = { snapshot: SubagentRankingsSnapshot } | { error: SubagentRankingsError };
  const sources = new Map<EnvironmentId, SubscriptionRef.SubscriptionRef<Source>>();
  const supervisors = new Map(
    yield* Effect.forEach([home, remote], (environmentId) =>
      Effect.gen(function* () {
        const source = yield* SubscriptionRef.make<Source>({
          snapshot: { models: [], thumbs: [] },
        });
        sources.set(environmentId, source);
        const session = {
          client: {
            [WS_METHODS.subagentRankingsToggleThumb]: (input: SubagentRankingsThumbInput) =>
              Effect.sync(() => {
                calls.push({ environmentId, input });
              }),
            [WS_METHODS.subagentRankingsSubscribe]: () =>
              SubscriptionRef.changes(source).pipe(
                Stream.mapEffect((state) =>
                  "error" in state ? Effect.fail(state.error) : Effect.succeed(state.snapshot),
                ),
              ),
          },
        } as unknown as RpcSession;
        return [
          environmentId,
          {
            target: { environmentId, label: environmentId },
            session: yield* SubscriptionRef.make(Option.some(session)),
          } as unknown as EnvironmentSupervisor["Service"],
        ] as const;
      }),
    ),
  );
  const run: EnvironmentRegistry["Service"]["run"] = (id, effect) =>
    effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisors.get(destination ?? id)!));
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (id, stream) =>
    stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisors.get(id)!));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, { run, followStream } as EnvironmentRegistry["Service"]),
  );
  const atoms = createSubagentRankingsAtoms(runtime);
  const registry = AtomRegistry.make();
  registry.mount(sessions(home));
  registry.mount(sessions(remote));
  registry.set(sessions(home), AsyncResult.success(grant(true)));
  registry.set(sessions(remote), AsyncResult.success(grant(false)));
  registry.mount(atoms.thumbAtom(home, task));
  registry.mount(atoms.thumbAtom(remote, task));
  yield* AtomRegistry.getResult(registry, atoms.subscribe({ environmentId: home, input: {} }));
  const receive = (state: Source, selected: "up" | "down" | null | undefined) =>
    Effect.all(
      [
        Effect.callback<void>((resume) => {
          const unsubscribe = registry.subscribe(atoms.thumbAtom(home, task), (value) => {
            if (value === selected) resume(Effect.void);
          });
          return Effect.sync(unsubscribe);
        }),
        SubscriptionRef.set(sources.get(home)!, state),
      ],
      { concurrency: "unbounded" },
    );
  return { atoms, registry, calls, receive };
});

describe("subagent rankings", () => {
  it("keeps family evidence separate by model and provider, and legacy rows exact", () => {
    const family = modelRankingRunEvidence({ id: "gpt", family: "gpt", label: "GPT" }, models);
    expect(family.map((model) => [model.instanceId, model.model])).toEqual([
      [provider, "gpt-6.1"],
      ["other-account", "gpt-6.1"],
      [provider, "gpt-6.2"],
    ]);
    expect(
      modelRankingRunEvidence(
        { id: "old", label: "GPT", selection: { instanceId: provider, model: "gpt-6.1" } },
        models,
      ),
    ).toEqual([models[0]]);
    expect(modelRankingRunEvidence({ id: "new", family: "new", label: "New" }, models)).toEqual([]);
    const details = modelRankingRunDetails(family);
    expect(details).toContain("gpt-6.1 · codex: 14 tasks, 86% done");
    expect(details).toContain("code: 10 tasks, 90% done");
    expect(details).toContain("gpt-6.1 · other-account: 2 tasks, 50% done");
    expect(details).not.toContain("opus");
    expect(details).toContain("Last 60 days. Your thumbs weigh more than parent grades.");
    expect(modelRankingRunDetails([])).toBe("");
  });

  it("only offers feedback for terminal app-owned tasks", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      expect(canRateSubagent({ origin: "app_owned", status })).toBe(true);
      expect(canRateSubagent({ origin: "provider_native", status })).toBe(false);
    }
    for (const status of ["pending", "running", "waiting", "idle"] as const) {
      expect(canRateSubagent({ origin: "app_owned", status })).toBe(false);
    }
  });

  it.effect(
    "distinguishes unrated records, missing records, clearing, and separate environments",
    () =>
      Effect.gen(function* () {
        const { atoms, registry, receive } = yield* harness();
        try {
          expect(registry.get(atoms.thumbAtom(home, task))).toBeUndefined();
          yield* receive({ snapshot: { models, thumbs: [{ taskId: task }] } }, null);
          expect(registry.get(atoms.thumbAtom(home, task))).toBeNull();
          expect(registry.get(atoms.thumbAtom(remote, task))).toBeUndefined();
          yield* receive({ snapshot: { models, thumbs: [{ taskId: task, thumb: "up" }] } }, "up");
          expect(registry.get(atoms.thumbAtom(home, task))).toBe("up");
          yield* receive(
            { snapshot: { models, thumbs: [{ taskId: task, thumb: "down" }] } },
            "down",
          );
          expect(registry.get(atoms.thumbAtom(home, task))).toBe("down");
          yield* receive({ snapshot: { models, thumbs: [{ taskId: task }] } }, null);
          expect(registry.get(atoms.thumbAtom(home, task))).toBeNull();
          yield* receive({ snapshot: { models: [], thumbs: [] } }, undefined);
          expect(registry.get(atoms.thumbAtom(home, task))).toBeUndefined();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect("drops stale feedback eligibility when the snapshot fails", () =>
    Effect.gen(function* () {
      const { atoms, registry, receive } = yield* harness();
      try {
        yield* receive({ snapshot: { models, thumbs: [{ taskId: task }] } }, null);
        expect(registry.get(atoms.thumbAtom(home, task))).toBeNull();
        yield* receive(
          { error: new SubagentRankingsError({ operation: "read", message: "disconnected" }) },
          undefined,
        );
        expect(registry.get(atoms.thumbAtom(home, task))).toBeUndefined();
        expect(registry.get(atoms.snapshotAtom(home))).toBeNull();
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect("guards the command with the task owner's current operate permission", () =>
    Effect.gen(function* () {
      const { atoms, registry, calls } = yield* harness();
      try {
        const command = atoms.toggleThumb;
        const input = { taskId: task, thumb: "up" as const };
        expect(registry.get(command.permissionAtom(home))).toBe(true);
        expect(registry.get(command.permissionAtom(remote))).toBe(false);
        expect(
          (yield* Effect.promise(() => command.run(registry, { environmentId: remote, input })))
            ._tag,
        ).toBe("Failure");
        expect(calls).toEqual([]);
        expect(
          (yield* Effect.promise(() => command.run(registry, { environmentId: home, input })))._tag,
        ).toBe("Success");
        expect(calls).toEqual([{ environmentId: home, input }]);
        registry.set(
          sessions(home),
          AsyncResult.success({ ...grant(true), permissions: [AuthSettingsWriteScope] }),
        );
        expect(registry.get(command.permissionAtom(home))).toBe(false);
        expect(
          (yield* Effect.promise(() => command.run(registry, { environmentId: home, input })))._tag,
        ).toBe("Failure");
        expect(calls).toHaveLength(1);
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect("rechecks a routed command against its actual destination", () =>
    Effect.gen(function* () {
      const { atoms, registry, calls } = yield* harness(remote);
      try {
        const result = yield* Effect.promise(() =>
          atoms.toggleThumb.run(registry, {
            environmentId: home,
            input: { taskId: task, thumb: "down" },
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(squashAtomCommandFailure(result)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthOrchestrationOperateScope,
          });
        }
        expect(calls).toEqual([]);
      } finally {
        registry.dispose();
      }
    }),
  );
});
