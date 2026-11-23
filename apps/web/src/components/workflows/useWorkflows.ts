import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WorkflowCompileRequest,
  WorkflowCompileResult,
  WorkflowIssue,
  WorkflowOperation,
  WorkflowStartRequest,
  WorkflowStartResult,
  WorkflowsState,
} from "@t3tools/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsFixture } from "./workflowsFixture";

export type WorkflowResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly message: string;
      readonly issues: ReadonlyArray<WorkflowIssue>;
      readonly interrupted: boolean;
    };

function toResult<A, E>(result: AtomCommandResult<A, E>, fallback: string): WorkflowResult<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  if (isAtomCommandInterrupted(result)) {
    return { ok: false, message: fallback, issues: [], interrupted: true };
  }
  const cause = squashAtomCommandFailure(result);
  const issues =
    typeof cause === "object" && cause !== null && "issues" in cause && Array.isArray(cause.issues)
      ? (cause.issues as WorkflowIssue[])
      : [];
  const message = cause instanceof Error && cause.message.trim() ? cause.message : fallback;
  return { ok: false, message, issues, interrupted: false };
}

const EMPTY_STATE: WorkflowsState = { version: 1, workflows: [], runs: [] };
const noopSubscribe = () => () => {};
const noFixture = () => null;

export interface WorkflowsView {
  readonly state: WorkflowsState;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canEdit: boolean;
}

/**
 * Live Workflows state for one environment. In dev, `localStorage
 * t3code:workflows:fixture=1` swaps in a simulated server so the UI can be
 * exercised before or without the real one.
 */
export function useWorkflowsState(environmentId: EnvironmentId | null): WorkflowsView {
  const fixture = import.meta.env.DEV ? workflowsFixture() : null;
  const fixtureState = useSyncExternalStore(
    fixture?.subscribe ?? noopSubscribe,
    fixture?.getState ?? noFixture,
  );
  const query = useEnvironmentQuery(
    fixture || environmentId === null
      ? null
      : serverEnvironment.workflowsState({ environmentId, input: {} }),
  );
  const permission = useAtomValue(
    serverEnvironment.mutateWorkflows.permissionAtom(environmentId ?? ("" as EnvironmentId)),
  );
  return useMemo(() => {
    if (fixtureState) {
      return { state: fixtureState, loading: false, error: null, canEdit: true };
    }
    return {
      state: query.data ?? EMPTY_STATE,
      // The stream stays open; it has loaded once its first state arrives.
      loading: query.data === null && query.error === null,
      error: query.error,
      canEdit: permission && query.isSuccess,
    };
  }, [fixtureState, permission, query.data, query.error, query.isSuccess]);
}

export function useWorkflowCommands(environmentId: EnvironmentId | null) {
  const mutate = useAtomCommand(serverEnvironment.mutateWorkflows, { reportFailure: false });
  const compile = useAtomCommand(serverEnvironment.compileWorkflow, { reportFailure: false });
  const start = useAtomCommand(serverEnvironment.startWorkflow, { reportFailure: false });
  const fixture = import.meta.env.DEV ? workflowsFixture() : null;

  const run = useCallback(
    async (operation: WorkflowOperation): Promise<WorkflowResult<void>> => {
      if (fixture) return fixture.mutate(operation);
      if (environmentId === null) return offline();
      return toResult(await mutate({ environmentId, input: operation }), "Couldn't save.");
    },
    [environmentId, fixture, mutate],
  );
  const compileWorkflow = useCallback(
    async (input: WorkflowCompileRequest): Promise<WorkflowResult<WorkflowCompileResult>> => {
      if (fixture) return fixture.compile(input);
      if (environmentId === null) return offline();
      return toResult(await compile({ environmentId, input }), "Couldn't resolve the drawing.");
    },
    [compile, environmentId, fixture],
  );
  const startWorkflow = useCallback(
    async (input: WorkflowStartRequest): Promise<WorkflowResult<WorkflowStartResult>> => {
      if (fixture) return fixture.start(input);
      if (environmentId === null) return offline();
      return toResult(await start({ environmentId, input }), "Couldn't start the run.");
    },
    [environmentId, fixture, start],
  );
  return useMemo(
    () => ({ mutate: run, compile: compileWorkflow, start: startWorkflow }),
    [compileWorkflow, run, startWorkflow],
  );
}

function offline(): WorkflowResult<never> {
  return { ok: false, message: "Connect to an environment first.", issues: [], interrupted: false };
}
