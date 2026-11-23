/** Text snapshots are private to one lease, and never contain automatic screenshots. */
export interface ComputerObservation {
  readonly snapshotId: string;
  readonly captureId?: string;
  readonly kind: "full" | "patch" | "unchanged";
  readonly baselineSnapshotId?: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedLines: number;
}

interface Baseline {
  readonly scope: string;
  readonly text: string;
  readonly at: number;
  readonly truncated: boolean;
  readonly omittedLines: number;
}

export function observationCharacterLimit(maxChars?: number): number {
  return Math.max(1, Math.min(20_000, Number.isFinite(maxChars) ? Math.floor(maxChars!) : 6_000));
}

/** Keep whole native lines, including their refs; never turn a partial ref into a usable target. */
function boundLines(text: string, maxChars: number) {
  const lines = text.split("\n");
  if (text.length <= maxChars) return { text, omittedLines: 0 };
  // Native status hints are trailing lines, so reserve room before trimming the tree.
  let hintStart = lines.length;
  while (
    hintStart > 0 &&
    /^\[(tree truncated|accessibility degraded: [^\n]*)\]$/.test(lines[hintStart - 1]!)
  )
    hintStart--;
  const hints = lines.slice(hintStart);
  const keepHints = hints.length > 0 && hints.join("\n").length <= maxChars;
  const body = keepHints ? lines.slice(0, hintStart) : lines;
  const available = keepHints ? maxChars - hints.join("\n").length - 1 : maxChars;
  let length = 0;
  let count = 0;
  for (const line of body) {
    const next = length + line.length + (count === 0 ? 0 : 1);
    if (next > available) break;
    length = next;
    count++;
  }
  const kept = [...body.slice(0, count), ...(keepHints ? hints : [])];
  return { text: kept.join("\n"), omittedLines: lines.length - kept.length };
}

/** A bounded cache allows diffs only against a baseline actually returned to this lease. */
export function makeComputerObservations(
  options: { readonly maxCount?: number; readonly ttlMs?: number } = {},
) {
  const baselines = new Map<string, Baseline>();
  const maxCount = options.maxCount ?? 32;
  const ttlMs = options.ttlMs ?? 120_000;
  let sequence = 0;
  return {
    clear: () => baselines.clear(),
    observe(input: {
      readonly scope: string;
      readonly now: number;
      readonly text: string;
      readonly captureId?: string;
      readonly maxChars?: number;
      readonly since?: string;
      readonly truncated?: boolean;
      readonly omittedLines?: number;
    }): ComputerObservation {
      for (const [id, baseline] of baselines) {
        if (input.now - baseline.at >= ttlMs) baselines.delete(id);
      }
      const bounded = boundLines(input.text, observationCharacterLimit(input.maxChars));
      const omittedLines = bounded.omittedLines + (input.omittedLines ?? 0);
      const truncated = input.truncated === true || omittedLines > 0;
      const candidate = input.since === undefined ? undefined : baselines.get(input.since);
      const baseline = candidate?.scope === input.scope ? candidate : undefined;
      const snapshotId = `observation-${++sequence}`;
      const metadata = {
        snapshotId,
        ...(input.captureId === undefined ? {} : { captureId: input.captureId }),
        truncated,
        omittedLines,
      };
      baselines.set(snapshotId, {
        scope: input.scope,
        text: bounded.text,
        at: input.now,
        truncated,
        omittedLines,
      });
      while (baselines.size > maxCount) baselines.delete(baselines.keys().next().value!);
      if (
        baseline !== undefined &&
        baseline.text === bounded.text &&
        baseline.truncated === truncated &&
        baseline.omittedLines === omittedLines
      ) {
        return {
          ...metadata,
          kind: "unchanged",
          baselineSnapshotId: input.since!,
          text: "unchanged",
        };
      }
      if (baseline !== undefined) {
        const before = baseline.text.split("\n");
        const after = bounded.text.split("\n");
        let prefix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
          prefix++;
        let suffix = 0;
        while (
          suffix < before.length - prefix &&
          suffix < after.length - prefix &&
          before[before.length - suffix - 1] === after[after.length - suffix - 1]
        )
          suffix++;
        const inserted = after.slice(prefix, after.length - suffix);
        const patch = `@@ line ${prefix + 1}, remove ${before.length - prefix - suffix}, insert ${inserted.length} @@${inserted.length === 0 ? "" : `\n${inserted.join("\n")}`}`;
        if (
          patch.length < bounded.text.length &&
          patch.length <= observationCharacterLimit(input.maxChars)
        ) {
          return { ...metadata, kind: "patch", baselineSnapshotId: input.since!, text: patch };
        }
      }
      return { ...metadata, kind: "full", text: bounded.text };
    },
  };
}
