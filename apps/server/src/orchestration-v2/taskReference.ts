// @effect-diagnostics nodeBuiltinImport:off - Deterministic hashing formats ids synchronously at wire boundaries.
import { NodeId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

// URI encoding cannot represent an unpaired surrogate. A literal percent is always escaped,
// so this prefix cannot collide with an existing request key.
export const encodeRequestPart = (value: string): string =>
  value.isWellFormed()
    ? encodeURIComponent(value)
    : `%u${encodeURIComponent(JSON.stringify(value))}`;

/** Stable across restarts and retries; canonical ids stay in events and commands. */
export const taskReference = (id: string): NodeId =>
  NodeId.make(
    id.length <= 16
      ? id
      : `t${NodeCrypto.createHash("sha256").update(id).digest("base64url").slice(0, 15)}`,
  );

/** Callers supply only tasks owned by the parent. Ambiguous aliases never select a task. */
export const resolveTaskReference = <A extends { readonly id: string }>(
  tasks: ReadonlyArray<A>,
  reference: string,
): A | undefined => {
  const exact = tasks.find((task) => task.id === reference);
  if (exact) return exact;
  const handles = tasks.filter((task) => taskReference(task.id) === reference);
  if (handles.length > 0) return handles.length === 1 ? handles[0] : undefined;
  // Request keys are escaped in the command id, then again in the node id.
  const suffix = encodeURIComponent(`:${encodeRequestPart(reference)}`);
  const matches = tasks.filter((task) => task.id.endsWith(suffix));
  return matches.length === 1 ? matches[0] : undefined;
};

export const withTaskReference = <A extends { readonly taskId: NodeId }>(result: A): A => ({
  ...result,
  taskId: taskReference(result.taskId),
});
