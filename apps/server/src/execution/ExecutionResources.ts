import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Schema from "effect/Schema";

export interface ExecutionResource {
  readonly id: string;
  readonly owner: { readonly threadId: ThreadId; readonly taskId: string };
  readonly workspace:
    | { readonly type: "local"; readonly cwd: string | null }
    | { readonly type: "remote"; readonly workspace: string };
  readonly state: "admitted" | "running" | "recovering" | "stopping" | "released";
  readonly cleanupPin: boolean;
  readonly stop:
    | { readonly type: "monitor"; readonly monitorId: string }
    | { readonly type: "subagent"; readonly threadId: ThreadId };
}

interface Query {
  readonly threadId?: ThreadId;
  readonly directory?: string;
  readonly kind?: ExecutionResource["stop"]["type"];
  readonly pinsOnly?: boolean;
}
interface StopRequest {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly reason?: string | undefined;
  readonly kind?: ExecutionResource["stop"]["type"];
}
interface Source<QueryError, StopError = QueryError> {
  readonly query: (query: Query) => Effect.Effect<ReadonlyArray<ExecutionResource>, QueryError>;
  readonly stop: (
    resources: ReadonlyArray<ExecutionResource>,
    request: StopRequest,
  ) => Effect.Effect<void, StopError>;
}

export class ExecutionResourceError extends Schema.TaggedError<ExecutionResourceError>()(
  "ExecutionResourceError",
  {
    operation: Schema.Literals(["query", "stop"]),
    kind: Schema.Literals(["monitor", "subagent"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.operation === "query"
      ? "Could not read execution ownership."
      : "Could not stop owned execution.";
  }
}

/**
 * Adapters enroll before admitting execution. Their journal/projections are the
 * ownership record, so restart recovery and cleanup see the same admission as Stop.
 * A failed read or stop never releases a pin. Process control stays in the adapter.
 */
export class ExecutionResources extends Context.Service<
  ExecutionResources,
  {
    readonly register: <QueryError, StopError>(
      kind: ExecutionResource["stop"]["type"],
      source: Source<QueryError, StopError>,
    ) => Effect.Effect<void>;
    readonly query: (
      query: Query,
    ) => Effect.Effect<ReadonlyArray<ExecutionResource>, ExecutionResourceError>;
    readonly stopOwned: (request: StopRequest) => Effect.Effect<void, ExecutionResourceError>;
  }
>()("t3/execution/ExecutionResources") {}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const sources = new Map<ExecutionResource["stop"]["type"], Source<ExecutionResourceError>>();
  const matches = (resource: ExecutionResource, query: Query) => {
    if (query.threadId !== undefined && resource.owner.threadId !== query.threadId) return false;
    if (query.pinsOnly === true && !resource.cleanupPin) return false;
    if (query.directory === undefined) return true;
    if (resource.workspace.type !== "local" || resource.workspace.cwd === null) return false;
    const relative = path.relative(
      path.resolve(query.directory),
      path.resolve(resource.workspace.cwd),
    );
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const selected = (query: Query) =>
    [...sources].filter(([kind]) => query.kind === undefined || query.kind === kind);
  const read = (source: Source<ExecutionResourceError>, query: Query) =>
    source
      .query(query)
      .pipe(Effect.map((resources) => resources.filter((resource) => matches(resource, query))));
  return ExecutionResources.of({
    register: (kind, source) =>
      Effect.sync(() => {
        sources.set(kind, {
          query: (query) =>
            source
              .query(query)
              .pipe(
                Effect.mapError(
                  (cause) => new ExecutionResourceError({ operation: "query", kind, cause }),
                ),
              ),
          stop: (resources, request) =>
            source
              .stop(resources, request)
              .pipe(
                Effect.mapError(
                  (cause) => new ExecutionResourceError({ operation: "stop", kind, cause }),
                ),
              ),
        });
      }),
    query: (query) =>
      Effect.forEach(selected(query), ([, source]) => read(source, query)).pipe(
        Effect.map((groups) => groups.flat()),
      ),
    stopOwned: (request) =>
      Effect.gen(function* () {
        let failure: ExecutionResourceError | undefined;
        for (const [, source] of selected(request)) {
          yield* read(source, request).pipe(
            Effect.flatMap((resources) => source.stop(resources, request)),
            Effect.catch((error) =>
              Effect.sync(() => {
                failure ??= error;
              }),
            ),
          );
        }
        if (failure !== undefined) return yield* failure;
      }),
  });
});

export const layer = Layer.effect(ExecutionResources, make).pipe(Layer.provide(NodePath.layer));
