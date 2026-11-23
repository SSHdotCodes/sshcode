import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { claudeSidechain, type UsageSessionDetail } from "./usageSessionDetails.ts";

export interface UsageAccountBinding {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly startedAt: string;
}

/** Shared logs have no login marker. Use the last app run begun in that native session. */
export function createUsageAttribution(
  bindings: readonly UsageAccountBinding[],
  instanceIds: readonly string[],
  files: readonly {
    readonly path?: string;
    readonly records: readonly UsageRecord[];
    readonly details?: readonly UsageSessionDetail[] | undefined;
  }[],
) {
  const allowed = new Set(instanceIds);
  const sessions = new Map<string, { instanceId: string; start: number }[]>();
  for (const binding of bindings) {
    if (!allowed.has(binding.instanceId) || !binding.sessionId) continue;
    const start = Date.parse(binding.startedAt);
    if (!Number.isFinite(start)) continue;
    const runs = sessions.get(binding.sessionId) ?? [];
    runs.push({ instanceId: binding.instanceId, start });
    sessions.set(binding.sessionId, runs);
  }
  for (const runs of sessions.values())
    runs.sort((a, b) => a.start - b.start || a.instanceId.localeCompare(b.instanceId));

  const parents = new Map<string, string>();
  const firstUsage = new Map<string, number>();
  for (const file of files) {
    for (const detail of file.details ?? [])
      if (detail.kind === "subagent") parents.set(detail.sessionId, detail.parentSessionId);
    const sidechain = file.path ? claudeSidechain(file.path, file.records) : null;
    if (sidechain) parents.set(sidechain.sessionId, sidechain.parentSessionId);
    for (const record of file.records) {
      const sessionId = sidechain?.sessionId ?? record.sessionId;
      firstUsage.set(
        sessionId,
        Math.min(firstUsage.get(sessionId) ?? Infinity, record.timestampMs),
      );
    }
  }
  return (record: Pick<UsageRecord, "sessionId" | "timestampMs">): string | undefined => {
    let sessionId = record.sessionId;
    let timestamp = record.timestampMs;
    let seen: Set<string> | undefined;
    while (sessionId && !seen?.has(sessionId)) {
      const runs = sessions.get(sessionId);
      if (runs) {
        let lo = 0;
        let hi = runs.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (runs[mid]!.start <= timestamp) lo = mid + 1;
          else hi = mid;
        }
        if (lo > 0) {
          const latest = runs[lo - 1]!;
          for (let i = lo - 2; i >= 0 && runs[i]!.start === latest.start; i--)
            if (runs[i]!.instanceId !== latest.instanceId) return undefined;
          return latest.instanceId;
        }
      }
      // Native subagents inherit the account that launched them, even if the
      // parent's next app run changes accounts while the child is working.
      const parent = parents.get(sessionId);
      if (!parent) break;
      timestamp = Math.min(timestamp, firstUsage.get(sessionId) ?? timestamp);
      (seen ??= new Set()).add(sessionId);
      sessionId = parent;
    }
    // Before the first known app run, or outside the app, the log cannot tell.
    return undefined;
  };
}
