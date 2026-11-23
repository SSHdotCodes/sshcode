// @effect-diagnostics globalDate:off -- Pure aggregation formats supplied instants in the viewer's zone.
import type { ProviderInstanceId, ThreadId, ThreadUsage } from "@t3tools/contracts";
import { EMPTY_TOTALS, totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { priceUsage, type RateTable } from "./usagePricing.ts";
import { claudeSidechain, type UsageSessionDetail } from "./usageSessionDetails.ts";

export interface UsageThreadBinding {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly parentThreadId: ThreadId | null;
}
export interface ThreadUsageSource {
  readonly instanceId?: string | undefined;
  readonly instanceIds?: readonly string[] | undefined;
  readonly accountFor?: (
    record: Pick<UsageRecord, "sessionId" | "timestampMs">,
  ) => string | undefined;
  readonly files:
    | readonly {
        readonly path: string;
        readonly records: readonly UsageRecord[];
        readonly details?: readonly UsageSessionDetail[];
      }[]
    | null;
}

/** Attributes each billed event once; native and app-owned subagents roll into their ancestors. */
export function aggregateThreadUsage(input: {
  readonly threadId: ThreadId;
  readonly now: number;
  readonly timeZone: string;
  readonly weeklyStartMs: number | null;
  readonly weeklyEndMs: number | null;
  readonly accountInstanceIds: readonly string[];
  readonly bindings: readonly UsageThreadBinding[];
  readonly appSubagentRuns?: readonly {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly model: string;
  }[];
  readonly sources: readonly ThreadUsageSource[];
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
}): ThreadUsage {
  const empty = () => ({ tokens: { ...EMPTY_TOTALS }, costUsd: 0, unpricedTokens: 0 });
  const allTime = empty();
  const today = empty();
  let date: Intl.DateTimeFormat;
  try {
    date = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const todayKey = date.format(new Date(input.now));
  const sessionKeys = new Map<string | null, Map<string, string>>();
  const key = (instance: string | null, session: string) => {
    let sessions = sessionKeys.get(instance);
    if (!sessions) sessionKeys.set(instance, (sessions = new Map()));
    let identity = sessions.get(session);
    if (!identity) sessions.set(session, (identity = JSON.stringify([instance, session])));
    return identity;
  };
  const owners = new Map<string, UsageThreadBinding>();
  const accountInstances = new Set(input.accountInstanceIds);
  const chats = new Map(input.bindings.map((binding) => [binding.threadId, binding]));
  // The same native session may be bound more than once after resume. Attribute to
  // the first owner, never bill the same session independently to several chats.
  for (const binding of input.bindings)
    if (!owners.has(key(binding.instanceId, binding.sessionId)))
      owners.set(key(binding.instanceId, binding.sessionId), binding);
  // A canonical transcript directory can serve several logins for the same account.
  for (const binding of input.bindings) {
    if (!accountInstances.has(binding.instanceId)) continue;
    for (const instance of input.accountInstanceIds) {
      const sessionKey = key(instance, binding.sessionId);
      if (!owners.has(sessionKey)) owners.set(sessionKey, binding);
    }
  }
  const parents = new Map<string, string>();
  const reportedChildren = new Set<string>();
  const files = input.sources.flatMap((source) =>
    (source.files ?? []).map((file) => ({
      ...file,
      source,
      sidechain: claudeSidechain(file.path, file.records),
    })),
  );
  const instanceFor = (source: ThreadUsageSource, sessionId: string, timestampMs: number) =>
    source.accountFor?.({ sessionId, timestampMs }) ?? source.instanceId ?? "";
  for (const file of files) {
    const instances = file.source.instanceIds ?? [file.source.instanceId ?? ""];
    const addParent = (sessionId: string, parentSessionId: string) => {
      // Lineage is shared by the directory. Each event resolves which account
      // owns it before following these edges to its chat.
      for (const instance of instances)
        parents.set(key(instance, sessionId), key(instance, parentSessionId));
      reportedChildren.add(key(instanceFor(file.source, sessionId, input.now), sessionId));
    };
    for (const detail of file.details ?? []) {
      if (detail.kind === "subagent") addParent(detail.sessionId, detail.parentSessionId);
    }
    if (file.sidechain) addParent(file.sidechain.sessionId, file.sidechain.parentSessionId);
  }
  const ownerCache = new Map<
    string,
    { owner: UsageThreadBinding; nativeSubagent: boolean } | null
  >();
  const ownerOf = (sessionKey: string) => {
    if (ownerCache.has(sessionKey)) return ownerCache.get(sessionKey)!;
    const visited = new Set<string>();
    let current = sessionKey;
    while (!visited.has(current)) {
      visited.add(current);
      const owner = owners.get(current);
      if (owner) {
        const result = { owner, nativeSubagent: current !== sessionKey };
        ownerCache.set(sessionKey, result);
        return result;
      }
      const parent = parents.get(current);
      if (!parent) break;
      current = parent;
    }
    ownerCache.set(sessionKey, null);
    return null;
  };
  const ancestryCache = new Map<ThreadId, Set<ThreadId>>();
  const noAncestors = new Set<ThreadId>();
  const ancestors = (binding: UsageThreadBinding) => {
    const cached = ancestryCache.get(binding.threadId);
    if (cached) return cached;
    const ids = new Set<ThreadId>([binding.threadId]);
    let current = binding;
    while (current.parentThreadId && !ids.has(current.parentThreadId)) {
      ids.add(current.parentThreadId);
      const parent = chats.get(current.parentThreadId);
      if (!parent) break;
      current = parent;
    }
    ancestryCache.set(binding.threadId, ids);
    return ids;
  };
  const weekly = new Map<ThreadId, number>();
  let weeklyTotal = 0;
  let ownWeekly = 0;
  const seen = new Set<string>();
  const subagentRuns = new Set<string>();
  const models = new Map<string, { runs: Set<string>; tokens: number }>();
  const appRunThreads = new Set<ThreadId>();
  for (const run of input.appSubagentRuns ?? []) {
    const chat = chats.get(run.threadId);
    if (!chat || run.threadId === input.threadId || !ancestors(chat).has(input.threadId)) continue;
    const id = `run:${run.id}`;
    const name = input.modelAliases?.get(run.model) ?? run.model;
    const model = models.get(name) ?? { runs: new Set<string>(), tokens: 0 };
    model.runs.add(id);
    models.set(name, model);
    subagentRuns.add(id);
    appRunThreads.add(run.threadId);
  }
  const recordedSessions = new Set<string>();
  const compactions: ThreadUsage["compactions"] = {
    count: 0,
    summarizedTokens: 0,
    unknownSizes: 0,
    last: null,
  };
  const compactEvents = new Map<string, Extract<UsageSessionDetail, { kind: "compaction" }>>();
  const add = (
    amount: ReturnType<typeof empty>,
    record: UsageRecord,
    cost: number,
    unpriced: boolean,
  ) => {
    for (const category of Object.keys(amount.tokens) as (keyof typeof amount.tokens)[])
      amount.tokens[category] += record.totals[category];
    amount.costUsd += cost;
    if (unpriced) amount.unpricedTokens += totalTokens(record.totals);
  };
  for (const file of files) {
    for (const raw of file.records) {
      const session = file.sidechain?.sessionId ?? raw.sessionId;
      const instance = instanceFor(file.source, session, raw.timestampMs);
      const sessionKey = key(instance, session);
      if (reportedChildren.has(sessionKey)) recordedSessions.add(sessionKey);
      if (raw.timestampMs > input.now) continue;
      const inAccount = accountInstances.has(instance);
      // Copies in different homes of this account share a billing-event key.
      const eventKey =
        raw.dedupeKey === null
          ? null
          : `${raw.provider}:${inAccount ? key(null, session) : sessionKey}:${raw.dedupeKey}`;
      if (eventKey && seen.has(eventKey)) continue;
      if (eventKey) seen.add(eventKey);
      const owned = ownerOf(sessionKey);
      const chain = owned ? ancestors(owned.owner) : noAncestors;
      const alias = input.modelAliases?.get(raw.model);
      let record = raw;
      if (alias !== undefined) {
        const { rateModel: _rateModel, ...aliased } = raw;
        record = { ...aliased, model: alias };
      }
      const priced = priceUsage(input.rates, record, input.priceOverrides);
      if (chain.has(input.threadId)) {
        add(allTime, record, priced.costUsd, priced.costSource === "unpriced");
        if (date.format(new Date(record.timestampMs)) === todayKey)
          add(today, record, priced.costUsd, priced.costSource === "unpriced");
        if (owned && (owned.nativeSubagent || owned.owner.threadId !== input.threadId)) {
          const countSession = owned.nativeSubagent || !appRunThreads.has(owned.owner.threadId);
          if (countSession) subagentRuns.add(sessionKey);
          const model = models.get(record.model) ?? { runs: new Set<string>(), tokens: 0 };
          if (countSession) model.runs.add(sessionKey);
          model.tokens += totalTokens(record.totals);
          models.set(record.model, model);
        }
      }
      if (
        input.weeklyStartMs !== null &&
        input.weeklyEndMs !== null &&
        record.timestampMs >= input.weeklyStartMs &&
        record.timestampMs < input.weeklyEndMs &&
        inAccount
      ) {
        weeklyTotal += priced.costUsd;
        if (chain.has(input.threadId)) ownWeekly += priced.costUsd;
        if (owned) {
          // One top-level chat owns descendant cost in the ranking.
          const root = chain.has(input.threadId) ? input.threadId : [...chain].at(-1)!;
          weekly.set(root, (weekly.get(root) ?? 0) + priced.costUsd);
        }
      }
    }
    for (const detail of file.details ?? []) {
      if (detail.kind !== "compaction" || detail.timestampMs > input.now) continue;
      const session = file.sidechain?.sessionId ?? detail.sessionId;
      const instance = instanceFor(file.source, session, detail.timestampMs);
      const owned = ownerOf(key(instance, session));
      if (!owned || owned.owner.threadId !== input.threadId || owned.nativeSubagent) continue;
      const identity = key(instance, `${detail.sessionId}:${detail.timestampMs}`);
      const previous = compactEvents.get(identity);
      if (previous?.origin !== "boundary" || detail.origin === "boundary")
        compactEvents.set(identity, detail);
    }
  }
  for (const sessionKey of reportedChildren) {
    if (recordedSessions.has(sessionKey)) continue;
    const owned = ownerOf(sessionKey);
    if (
      !owned ||
      !ancestors(owned.owner).has(input.threadId) ||
      (!owned.nativeSubagent && owned.owner.threadId === input.threadId)
    )
      continue;
    if (!owned.nativeSubagent && appRunThreads.has(owned.owner.threadId)) continue;
    const model = models.get("Unknown model") ?? { runs: new Set<string>(), tokens: 0 };
    model.runs.add(sessionKey);
    models.set("Unknown model", model);
    subagentRuns.add(sessionKey);
  }
  // Codex can persist both the replacement history and its completion notification.
  // Match that pair before counting; a notification-only rollout still contributes.
  const boundaries = [...compactEvents.values()].filter((detail) => detail.origin === "boundary");
  for (const [identity, detail] of compactEvents) {
    if (
      detail.origin === "notification" &&
      boundaries.some(
        (boundary) =>
          boundary.sessionId === detail.sessionId &&
          Math.abs(boundary.timestampMs - detail.timestampMs) < 1000,
      )
    )
      compactEvents.delete(identity);
  }
  let last: ThreadUsage["compactions"]["last"] = null;
  let summarizedTokens = 0;
  let unknownSizes = 0;
  for (const detail of compactEvents.values()) {
    summarizedTokens += detail.beforeTokens ?? 0;
    if (detail.beforeTokens === null) unknownSizes++;
    if (last === null || detail.timestampMs > Date.parse(last.at))
      last = {
        beforeTokens: detail.beforeTokens,
        afterTokens: detail.afterTokens,
        at: new Date(detail.timestampMs).toISOString(),
      };
  }
  const selectedChat = chats.get(input.threadId);
  const selectedAncestors = selectedChat ? ancestors(selectedChat) : new Set<ThreadId>();
  const ranked = [...weekly].sort((a, b) => b[1] - a[1]);
  const selected = ranked.slice(0, 5);
  // Keep this chat visible even when it falls outside the top five.
  const own = ranked.find(([id]) => id === input.threadId);
  if (own && !selected.some(([id]) => id === input.threadId)) selected.push(own);
  const share = (cost: number) => (100 * cost) / weeklyTotal;
  return {
    readAt: new Date(input.now).toISOString(),
    allTime,
    today,
    compactions: {
      ...compactions,
      count: compactEvents.size,
      summarizedTokens,
      unknownSizes,
      last,
    },
    subagentRuns: subagentRuns.size,
    subagents: [...models]
      .map(([model, value]) => ({ model, runs: value.runs.size, tokens: value.tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    weeklyShare:
      weeklyTotal > 0 && input.weeklyStartMs !== null && input.weeklyEndMs !== null
        ? {
            percent: share(ownWeekly),
            startsAt: new Date(input.weeklyStartMs).toISOString(),
            endsAt: new Date(input.weeklyEndMs).toISOString(),
            chats: selected.map(([threadId, cost]) => ({
              threadId,
              title: `${chats.get(threadId)?.title ?? "Chat"}${threadId !== input.threadId && selectedAncestors.has(threadId) ? " (other work)" : ""}`,
              percent: share(cost),
            })),
            othersPercent: Math.max(
              0,
              100 - selected.reduce((sum, [, cost]) => sum + share(cost), 0),
            ),
          }
        : null,
    notes: [],
  };
}
