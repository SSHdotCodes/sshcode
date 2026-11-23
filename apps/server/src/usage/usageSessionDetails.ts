import { NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

export const UsageSessionDetail = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("subagent"),
    sessionId: Schema.String,
    parentSessionId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("compaction"),
    sessionId: Schema.String,
    timestampMs: Schema.Finite,
    origin: Schema.optional(Schema.Literals(["boundary", "notification"])),
    beforeTokens: Schema.NullOr(NonNegativeInt),
    afterTokens: Schema.NullOr(NonNegativeInt),
  }),
]);
export type UsageSessionDetail = typeof UsageSessionDetail.Type;

export const SESSION_DETAIL_FIELDS = {
  type: true,
  subtype: true,
  timestamp: true,
  sessionId: true,
  uuid: true,
  compactMetadata: true,
  compact_metadata: true,
  payload: {
    id: true,
    type: true,
    source: { subagent: { thread_spawn: { parent_thread_id: true } } },
  },
} as const;
export const SESSION_DETAIL_MARKERS = [
  '"session_meta"',
  '"compact_boundary"',
  '"context_compacted"',
  '"compacted"',
] as const;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function size(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/** Metadata only. Transcript bodies and compaction summaries never enter the cache. */
export function sessionDetails(value: unknown, sessionId: string): readonly UsageSessionDetail[] {
  const row = object(value);
  const payload = object(row.payload);
  if (row.type === "session_meta") {
    const parent = object(object(object(payload.source).subagent).thread_spawn).parent_thread_id;
    return typeof payload.id === "string" && typeof parent === "string"
      ? [{ kind: "subagent", sessionId: payload.id, parentSessionId: parent }]
      : [];
  }
  const compact =
    row.subtype === "compact_boundary" ||
    payload.type === "context_compacted" ||
    row.type === "compacted";
  const timestampMs = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  if (!compact || !Number.isFinite(timestampMs)) return [];
  const metadata = object(row.compactMetadata ?? row.compact_metadata);
  return [
    {
      kind: "compaction",
      sessionId: typeof row.sessionId === "string" ? row.sessionId : sessionId,
      timestampMs,
      ...(row.type === "compacted"
        ? { origin: "boundary" as const }
        : payload.type === "context_compacted"
          ? { origin: "notification" as const }
          : {}),
      beforeTokens: size(metadata.preTokens ?? metadata.pre_tokens),
      afterTokens: size(metadata.postTokens ?? metadata.post_tokens),
    },
  ];
}

/** Claude sidechains share their parent's sessionId; the path names the actual agent run. */
export function claudeSidechain(
  path: string,
  records: readonly UsageRecord[],
): { sessionId: string; parentSessionId: string } | null {
  const match = /[/\\](?:subagents[/\\])?(agent-[^/\\]+)\.jsonl$/.exec(path);
  const parentSessionId =
    records[0]?.sessionId ?? /[/\\]([^/\\]+)[/\\]subagents[/\\]/.exec(path)?.[1];
  return match && parentSessionId
    ? { sessionId: `${parentSessionId}/${match[1]}`, parentSessionId }
    : null;
}
