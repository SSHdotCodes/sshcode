import {
  WS_METHODS,
  type ClaudeRcEvent,
  type ClaudeRcItem,
  type ClaudeRcPermission,
} from "@t3tools/contracts";
import type * as Atom from "effect/reactivity/Atom";
import * as Stream from "effect/Stream";
import type * as EnvironmentRegistry from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

export interface ClaudeRcState {
  readonly phase: "connecting" | "connected" | "disconnected";
  readonly working: boolean;
  readonly message: string | null;
  readonly items: readonly ClaudeRcItem[];
  readonly permissions: readonly ClaudeRcPermission[];
}
export const initialClaudeRcState: ClaudeRcState = {
  phase: "connecting",
  working: false,
  message: null,
  items: [],
  permissions: [],
};

/** Durable event IDs replace replayed messages; nothing enters the normal thread store. */
export function reduceClaudeRcEvent(state: ClaudeRcState, event: ClaudeRcEvent): ClaudeRcState {
  switch (event.type) {
    case "textDelta": {
      const previous = state.items.find((item) => item.id === event.id);
      return reduceClaudeRcEvent(state, {
        type: "item",
        item: {
          id: event.id,
          role: "assistant",
          text: ((previous?.text ?? "") + event.text).slice(0, 64_000),
        },
      });
    }
    case "status":
      return {
        ...state,
        phase: event.phase,
        working: event.working,
        message: event.message ?? null,
      };
    case "item": {
      const index = state.items.findIndex((item) => item.id === event.item.id);
      const items = [...state.items];
      if (index < 0) items.push(event.item);
      else items[index] = event.item;
      return { ...state, items: items.slice(-300) };
    }
    case "permission":
      return {
        ...state,
        permissions: [
          ...state.permissions.filter((p) => p.requestId !== event.permission.requestId),
          event.permission,
        ],
      };
    case "permissionResolved":
      return {
        ...state,
        permissions: state.permissions.filter((p) => p.requestId !== event.requestId),
      };
  }
}

export function createClaudeRcEnvironmentAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  return {
    sessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "Claude CLI Remote Control sessions",
      tag: WS_METHODS.claudeRcSessions,
      staleTimeMs: 5_000,
      refreshIntervalMs: 10_000,
    }),
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "Claude CLI Remote Control",
      tag: WS_METHODS.claudeRcWatch,
      idleTtlMs: 0,
      resubscribeOnWakeup: true,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => initialClaudeRcState, reduceClaudeRcEvent)),
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "Claude CLI Remote Control input",
      tag: WS_METHODS.claudeRcCommand,
    }),
  };
}
