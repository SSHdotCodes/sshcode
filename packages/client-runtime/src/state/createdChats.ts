import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentShellState } from "./shell.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

/** Missing cards read one shell, once per connection generation or removal, never a transcript. */
export function createCreatedChatShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  shellState: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
  shellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>,
) {
  const query = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:created-chat-shell",
    execute: (input: {
      readonly threadId: ScopedThreadRef["threadId"];
      readonly generation: number;
      readonly removedAt: number;
    }) => request(ORCHESTRATION_V2_WS_METHODS.getThreadShell, { threadId: input.threadId }),
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 60_000,
  });
  const family = Atom.family((key: string) => {
    const [environmentId, threadId] = key.split("\n") as [
      EnvironmentId,
      ScopedThreadRef["threadId"],
    ];
    const ref = { environmentId, threadId };
    return Atom.make((get) => {
      const live = get(shellAtom(ref));
      if (live !== null) return live.source;
      const state = get(shellState(environmentId));
      if (state.generation === 0) return undefined;
      const result = get(
        query({
          environmentId,
          input: {
            threadId,
            generation: state.generation,
            removedAt: state.removedAt.get(threadId) ?? 0,
          },
        }),
      );
      return AsyncResult.isSuccess(result) ? result.value : undefined;
    });
  });
  return (ref: ScopedThreadRef) => family(`${ref.environmentId}\n${ref.threadId}`);
}
