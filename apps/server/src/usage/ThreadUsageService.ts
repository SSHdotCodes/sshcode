import { UsageReadError, ThreadUsageInput, type ThreadUsage } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import * as UsageService from "./UsageService.ts";
import { aggregateThreadUsage } from "./threadUsageAggregation.ts";

export class ThreadUsageService extends Context.Service<
  ThreadUsageService,
  {
    readonly read: (input: ThreadUsageInput) => Effect.Effect<ThreadUsage, UsageReadError>;
  }
>()("t3/usage/ThreadUsageService") {}

const isUsageReadError = Schema.is(UsageReadError);

const make = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const limitSources = yield* UsageLimitSources.UsageLimitSources;
  const codec = Schema.fromJsonString(ThreadUsageInput);
  const decode = Schema.decodeEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const cache = yield* Cache.make({
    capacity: 128,
    timeToLive: "1 minute",
    lookup: (key: string) =>
      Effect.gen(function* () {
        const input = yield* decode(key);
        const now = yield* Clock.currentTimeMillis;
        const { thread } = yield* projections.getThreadRecords(input.threadId, []);
        const providers = yield* registry.getProviders;
        const provider = providers.find((p) => p.instanceId === thread.providerInstanceId);
        const sameAccount = providers
          .filter(
            (p) =>
              p.instanceId === thread.providerInstanceId ||
              (provider &&
                p.driver === provider.driver &&
                p.auth.workspaceId === provider.auth.workspaceId &&
                ((provider.auth.email &&
                  p.auth.email?.trim().toLowerCase() ===
                    provider.auth.email.trim().toLowerCase()) ||
                  (provider.usageLimits?.credentialFingerprint &&
                    p.usageLimits?.credentialFingerprint ===
                      provider.usageLimits.credentialFingerprint))),
          )
          .map((p) => p.instanceId);
        const sources = yield* limitSources.current;
        const report = collectProviderUsageLimits(
          thread.providerInstanceId,
          providers,
          sources,
          now,
        );
        const limits =
          report?.accounts.find((account) => account.instanceId === thread.providerInstanceId)
            ?.limits ?? provider?.usageLimits;
        const window = limits?.windows.find(
          (w) => w.kind === "weekly" && w.resetsAt && Date.parse(w.resetsAt) > now,
        );
        const weeklyEndMs = window?.resetsAt ? Date.parse(window.resetsAt) : null;
        const weeklyStartMs =
          weeklyEndMs === null
            ? null
            : weeklyEndMs - (window?.windowDurationMins ?? 7 * 24 * 60) * 60_000;
        const [records, { mapping, appRuns }, observed] = yield* Effect.all(
          [
            usage.readThreadRecords,
            projections
              .getUsageBindings(
                input.threadId,
                providers.map((p) => p.instanceId),
              )
              .pipe(
                Effect.flatMap((mapping) => {
                  const parents = new Map(
                    mapping.bindings.map((binding) => [binding.threadId, binding.parentThreadId]),
                  );
                  const descendants = [
                    ...new Set(
                      mapping.bindings
                        .filter((binding) => {
                          const seen = new Set<ThreadUsageInput["threadId"]>();
                          let parent = binding.parentThreadId;
                          while (parent && !seen.has(parent)) {
                            if (parent === input.threadId) return true;
                            seen.add(parent);
                            parent = parents.get(parent) ?? null;
                          }
                          return false;
                        })
                        .map((binding) => binding.threadId),
                    ),
                  ];
                  return projections
                    .getUsageSubagentRuns(descendants)
                    .pipe(Effect.map((appRuns) => ({ mapping, appRuns })));
                }),
              ),
            projections.getUsageCompactions(input.threadId),
          ],
          { concurrency: "unbounded" },
        );
        const result = aggregateThreadUsage({
          ...input,
          now,
          weeklyStartMs,
          weeklyEndMs,
          accountInstanceIds: sameAccount,
          bindings: mapping.bindings,
          appSubagentRuns: appRuns.runs,
          ...records,
        });
        // Persisted app items know sizes that native rollouts sometimes omit. A full
        // bounded history is authoritative when it covers at least the transcript count.
        const items = observed.items.filter((item) => item.status === "completed");
        const latest = [...items].sort(
          (a, b) =>
            DateTime.toEpochMillis(b.completedAt ?? b.updatedAt) -
            DateTime.toEpochMillis(a.completedAt ?? a.updatedAt),
        )[0];
        const compactions =
          !observed.truncated && items.length >= result.compactions.count && items.length > 0
            ? {
                count: items.length,
                summarizedTokens: items.reduce(
                  (sum, item) => sum + (item.beforeTokenCount ?? 0),
                  0,
                ),
                unknownSizes: items.filter((item) => item.beforeTokenCount === undefined).length,
                last: latest
                  ? {
                      beforeTokens: latest.beforeTokenCount ?? null,
                      afterTokens: latest.afterTokenCount ?? null,
                      at: DateTime.formatIso(latest.completedAt ?? latest.updatedAt),
                    }
                  : null,
              }
            : latest &&
                result.compactions.last &&
                Math.abs(
                  DateTime.toEpochMillis(latest.completedAt ?? latest.updatedAt) -
                    Date.parse(result.compactions.last.at),
                ) < 60_000
              ? {
                  ...result.compactions,
                  last: {
                    ...result.compactions.last,
                    beforeTokens: latest.beforeTokenCount ?? result.compactions.last.beforeTokens,
                    afterTokens: latest.afterTokenCount ?? result.compactions.last.afterTokens,
                  },
                }
              : result.compactions;
        return {
          ...result,
          compactions,
          notes: [
            "Observed transcripts on this environment, including subagents. Deleted history may be incomplete.",
            "Account attribution follows configured transcript homes; historical account switches cannot be distinguished.",
            ...(records.partial ? ["Some usage sources could not finish reporting."] : []),
            ...(mapping.truncated
              ? ["Chat mapping is bounded; unmapped weekly usage is included in Others."]
              : []),
            ...(appRuns.truncated
              ? ["Subagent run counts are bounded; older runs may be missing."]
              : []),
            ...(observed.truncated ? ["Older compactions rely on retained transcripts."] : []),
            ...(!provider?.auth.email && !provider?.usageLimits?.credentialFingerprint
              ? ["Account attribution is limited to this configured provider instance."]
              : []),
          ],
        } satisfies ThreadUsage;
      }).pipe(
        Effect.mapError((cause) =>
          isUsageReadError(cause)
            ? cause
            : new UsageReadError({
                reason: "scanFailed",
                detail: "Could not read chat usage.",
                cause,
              }),
        ),
      ),
  });
  return ThreadUsageService.of({
    read: (input) =>
      encode(input).pipe(
        Effect.flatMap((key) => Cache.get(cache, key)),
        Effect.mapError(
          (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Could not read chat usage.",
              cause,
            }),
        ),
      ),
  });
});
export const layer = Layer.effect(ThreadUsageService, make);
