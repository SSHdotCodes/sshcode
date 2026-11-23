import {
  ModelRankingsSaveError,
  type EnvironmentId,
  ModelRankings,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { createServerEnvironmentAtoms } from "./state/server.ts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "./state/runtime.ts";

export * as ModelRankingNoteDraft from "./modelRankingNoteDraft.ts";

const isModelRankingsSaveError = Schema.is(ModelRankingsSaveError);
const sameRankings = Schema.toEquivalence(ModelRankings);

type RankingSettingsBindings = Pick<
  ReturnType<typeof createServerEnvironmentAtoms>,
  "settingsValueAtom" | "updateSettings"
> & {
  configValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Pick<ServerConfig, "modelRankingsConcurrency"> | null>;
};

/** Shared optimistic state; all persistence still uses the guarded settings command. */
export function createModelRankingsEditorState(server: RankingSettingsBindings) {
  type LocalState = {
    error: string | null;
    conflict: boolean;
    pending: {
      base: ModelRankings;
      value: ModelRankings;
      status: "saving" | "failed" | "saved";
      behind: ReadonlyArray<ModelRankings>;
    } | null;
  };
  const initial: LocalState = { error: null, conflict: false, pending: null };
  const receive = (local: LocalState, source: ModelRankings | undefined): LocalState => {
    const pending = local.pending;
    if (!pending) return local;
    const caughtUp = source !== undefined && sameRankings(source, pending.value);
    const index =
      source === undefined ? -1 : pending.behind.findIndex((saved) => sameRankings(saved, source));
    if (pending.status === "saved" && (caughtUp || index < 0)) return { ...local, pending: null };
    // Keep only acknowledged predecessors the stream has yet to pass. An unknown
    // external snapshot supersedes the chain, but never removes a failed draft.
    if (index === 0 || (index < 0 && pending.behind.length === 0)) return local;
    return {
      ...local,
      pending: { ...pending, behind: index < 0 ? [] : pending.behind.slice(index) },
    };
  };
  const localAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.writable(
      (get): LocalState =>
        receive(
          Option.getOrElse(get.self<LocalState>(), () => initial),
          get(server.settingsValueAtom(environmentId))?.modelRankings,
        ),
      (ctx, local: LocalState) =>
        ctx.setSelf(
          receive(local, ctx.get(server.settingsValueAtom(environmentId))?.modelRankings),
        ),
    ),
  );
  const draftVersionAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const permissionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(server.configValueAtom(environmentId))?.modelRankingsConcurrency === true &&
        get(server.updateSettings.permissionAtom(environmentId)),
    ),
  );
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const settings = get(server.settingsValueAtom(environmentId));
      const local = get(localAtom(environmentId));
      const pending = local.pending;
      return {
        settings,
        canWrite: get(permissionAtom(environmentId)),
        rankings: pending ? pending.value : (settings?.modelRankings ?? []),
        baseRankings: pending
          ? pending.status === "saved"
            ? pending.value
            : pending.base
          : (settings?.modelRankings ?? []),
        saving: pending?.status === "saving",
        error: local.error,
        unsaved: pending?.status === "failed",
        conflict: local.conflict,
        draftVersion: get(draftVersionAtom(environmentId)),
      };
    }),
  );
  const inFlight = new Map<EnvironmentId, ReturnType<typeof server.updateSettings.run>>();
  const save = {
    label: "save model family rankings",
    permissionAtom,
    run: (
      registry: AtomRegistry.AtomRegistry,
      target: {
        environmentId: EnvironmentId;
        input: ModelRankings;
        expectedModelRankings: ModelRankings;
      },
    ) => {
      const previous = inFlight.get(target.environmentId);
      if (previous) return previous;
      const { environmentId, input, expectedModelRankings: base } = target;
      const previousPending = registry.get(localAtom(environmentId)).pending;
      const history = previousPending?.behind ?? [];
      const behind =
        history.length > 0 && sameRankings(history[history.length - 1]!, base)
          ? history
          : [...history, base];
      registry.set(localAtom(environmentId), {
        error: null,
        conflict: false,
        pending: { base, value: input, status: "saving", behind },
      });
      // Older hosts would ignore the expected snapshot and accept an unsafe replacement.
      const supported =
        registry.get(server.configValueAtom(environmentId))?.modelRankingsConcurrency === true;
      const request: ReturnType<typeof server.updateSettings.run> = supported
        ? server.updateSettings.run(registry, {
            environmentId,
            input: { patch: { modelRankings: input }, expectedModelRankings: base },
          })
        : Promise.resolve(
            AsyncResult.failure(Cause.fail(new ModelRankingsSaveError({ reason: "unsupported" }))),
          );
      const result = request
        .then((result) => {
          const remaining = registry.get(localAtom(environmentId)).pending?.behind ?? [];
          if (result._tag === "Success")
            registry.set(localAtom(environmentId), {
              error: null,
              conflict: false,
              pending: {
                base,
                value: result.value.modelRankings,
                status: "saved",
                behind: remaining,
              },
            });
          else {
            const failure = squashAtomCommandFailure(result);
            registry.set(localAtom(environmentId), {
              pending: { base, value: input, status: "failed", behind: remaining },
              conflict: isModelRankingsSaveError(failure) && failure.reason === "conflict",
              error: isAtomCommandInterrupted(result)
                ? null
                : failure instanceof Error
                  ? failure.message
                  : "Model family rankings could not be saved.",
            });
          }
          return result;
        })
        .finally(() => inFlight.delete(environmentId));
      inFlight.set(environmentId, result);
      return result;
    },
  };
  const discard = {
    label: "discard unsaved model family rankings",
    run: (registry: AtomRegistry.AtomRegistry, target: { environmentId: EnvironmentId }) => {
      registry.set(
        draftVersionAtom(target.environmentId),
        registry.get(draftVersionAtom(target.environmentId)) + 1,
      );
      registry.set(localAtom(target.environmentId), {
        error: null,
        conflict: false,
        pending: null,
      });
      return Promise.resolve(AsyncResult.success(undefined));
    },
  };
  return { stateAtom, save, discard };
}
