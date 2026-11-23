// @effect-diagnostics nodeBuiltinImport:off
/**
 * Mistral Vibe session usage, read from its unified session store.
 *
 * Each session keeps snapshots under `generations/<n>/` and appends what
 * happened since snapshot `n` to `journal/<n + 1>.jsonl`. Vibe prunes old
 * generations and their journals, so the server's scan cache is what keeps
 * pruned usage. A completed model call is journalled as a `core_input` whose
 * command is `completion_succeeded`, with its token usage and the call's
 * time; the journal never names the model, so a file's state starts from the
 * snapshot it follows. The transcript engine asks for that state synchronously
 * mid-parse, hence plain `node:fs`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** Vibe's built-in model when neither the session nor `config.toml` picks one. */
export const VIBE_DEFAULT_MODEL = "mistral-medium-3.5";

const VibeScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  model: Schema.mutableKey(Schema.String),
  rateModel: Schema.mutableKey(Schema.String),
});
type VibeScanState = typeof VibeScanState.Type;

const CompletionInput = Schema.Struct({
  type: Schema.Literal("core_input"),
  payload: Schema.Struct({
    input: Schema.Struct({
      command: Schema.Struct({
        type: Schema.Literal("completion_succeeded"),
        action_id: Schema.NonEmptyString,
        result: Schema.Struct({
          usage: Schema.Struct({
            input_tokens: Schema.optional(Schema.Unknown),
            cached_input_tokens: Schema.optional(Schema.Unknown),
            output_tokens: Schema.optional(Schema.Unknown),
          }),
        }),
      }),
      determinism: Schema.Struct({ time_unix_ms: Schema.Number }),
    }),
  }),
});
const decodeCompletionInput = Schema.decodeUnknownOption(CompletionInput);

function readText(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonFile(filePath: string): unknown {
  const text = readText(filePath);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sessionActiveModel(
  sessionDir: string,
  beforeGeneration: number,
  parentHops = 0,
): string | undefined {
  let generations: number[];
  try {
    generations = NodeFS.readdirSync(NodePath.join(sessionDir, "generations"))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .toSorted((left, right) => right - left);
  } catch {
    return undefined;
  }
  // The snapshot a journal follows, else the newest one before it, else the newest.
  const generation =
    generations.find((candidate) => candidate <= beforeGeneration) ?? generations[0];
  if (generation === undefined) return undefined;
  const state = readJsonFile(
    NodePath.join(
      sessionDir,
      "generations",
      String(generation).padStart(16, "0"),
      "runtime-state.json",
    ),
  ) as
    | {
        readonly session_metadata?: {
          readonly active_model?: unknown;
          readonly parent_session_id?: unknown;
        };
      }
    | undefined;
  const metadata = state?.session_metadata;
  if (typeof metadata?.active_model === "string" && metadata.active_model.trim()) {
    return metadata.active_model.trim();
  }
  // Subagent sessions leave the model unset and run on their parent's.
  const parent = metadata?.parent_session_id;
  return parentHops < 4 && typeof parent === "string" && /^[\w-]+$/.test(parent)
    ? sessionActiveModel(
        NodePath.join(NodePath.dirname(sessionDir), parent),
        Infinity,
        parentHops + 1,
      )
    : undefined;
}

interface VibeConfig {
  readonly activeModel: string | undefined;
  readonly models: ReadonlyMap<string, { readonly name: string; readonly provider: string }>;
}

/** The two `config.toml` settings usage needs, read without a TOML parser. */
export function parseVibeConfig(toml: string): VibeConfig {
  const activeModel = /^\s*active_model\s*=\s*"([^"]*)"/m.exec(toml)?.[1]?.trim() || undefined;
  const models = new Map<string, { name: string; provider: string }>();
  for (const [table] of toml.matchAll(/\{[^{}]*\}/g)) {
    const field = (key: string) => new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(table)?.[1];
    const alias = field("alias");
    const name = field("name");
    if (alias && name) models.set(alias, { name, provider: field("provider") || "mistral" });
  }
  return { activeModel, models };
}

interface VibeModelConfig {
  readonly alias?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
}

/**
 * Model routing Vibe fetches from its experiment service: the default model a
 * session without one runs on, and extra models with their aliases. Only the
 * latest evaluation is cached, so it stands in for older sessions too.
 */
export function parseVibeExperiments(document: unknown): VibeConfig {
  const models = new Map<string, { name: string; provider: string }>();
  let activeModel: string | undefined;
  const addModel = (model: VibeModelConfig | undefined) => {
    if (typeof model?.alias === "string" && typeof model.name === "string") {
      models.set(model.alias, {
        name: model.name,
        provider: typeof model.provider === "string" ? model.provider : "mistral",
      });
    }
  };
  const evaluations =
    typeof document === "object" && document !== null ? Object.values(document) : [];
  for (const evaluation of evaluations) {
    const features = (evaluation as { payload?: { features?: Record<string, unknown> } })?.payload
      ?.features;
    const routing = (
      features?.vibe_cli_default_routing_model as
        | { defaultValue?: { active_model?: unknown; model_config?: VibeModelConfig } }
        | undefined
    )?.defaultValue;
    if (typeof routing?.active_model === "string" && routing.active_model) {
      activeModel ??= routing.active_model;
    }
    addModel(routing?.model_config);
    const extra = (
      features?.vibe_cli_extra_models as { defaultValue?: { models?: unknown } } | undefined
    )?.defaultValue?.models;
    if (Array.isArray(extra)) for (const model of extra) addModel(model as VibeModelConfig);
  }
  return { activeModel, models };
}

/** A journal's starting state: its session and the model that session ran on. */
export function vibeJournalState(filePath: string): VibeScanState {
  // <VIBE_HOME>/logs/session/unified/<session>/journal/<generation>.jsonl
  const sessionDir = NodePath.dirname(NodePath.dirname(filePath));
  const home = NodePath.resolve(sessionDir, "..", "..", "..", "..");
  const config = parseVibeConfig(readText(NodePath.join(home, "config.toml")) ?? "");
  const experiments = parseVibeExperiments(
    readJsonFile(NodePath.join(home, "experiment_eval_cache.json")),
  );
  const generation = Number.parseInt(NodePath.basename(filePath, ".jsonl"), 10) - 1;
  // A session with no model ran on config's, else the routed default, else the built-in one.
  const model =
    sessionActiveModel(sessionDir, Number.isFinite(generation) ? generation : Infinity) ??
    config.activeModel ??
    experiments.activeModel ??
    VIBE_DEFAULT_MODEL;
  // Sessions record the alias; rates are listed under the provider's model name.
  const configured = config.models.get(model) ?? experiments.models.get(model);
  return {
    sessionId: NodePath.basename(sessionDir),
    model,
    rateModel: configured ? `${configured.provider}/${configured.name}` : `mistral/${model}`,
  };
}

function parseRecord(parsed: unknown, state: VibeScanState): readonly UsageRecord[] {
  const decoded = decodeCompletionInput(parsed);
  if (Option.isNone(decoded)) return [];
  const { command, determinism } = decoded.value.payload.input;
  const usage = command.result.usage;
  const inputTokens = tokenCount(usage.input_tokens);
  // Cached input is part of `input_tokens`.
  const cachedInputTokens = Math.min(inputTokens, tokenCount(usage.cached_input_tokens));
  const totals = {
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens: 0,
    outputTokens: tokenCount(usage.output_tokens),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "vibe",
      timestampMs: determinism.time_unix_ms,
      model: state.model,
      rateModel: state.rateModel,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: JSON.stringify(["vibe", state.sessionId, command.action_id]),
    },
  ];
}

export const vibeUsageFormat: TranscriptUsageFormat<VibeScanState> = {
  selectFields: {
    type: true,
    payload: {
      input: {
        command: { type: true, action_id: true, result: { usage: true } },
        determinism: true,
      },
    },
  },
  usageMarkers: ['"completion_succeeded"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: vibeJournalState, schema: VibeScanState },
};

/** Vibe instances keep their own home while sharing the registry driver. */
export const vibeUsageReader: ProviderUsageReader<AcpRegistrySettings, never> = {
  kind: "transcripts",
  provider: "vibe",
  format: vibeUsageFormat,
  directories: Effect.fn("vibeUsageReader.directories")(function* ({ config, environment }) {
    if (config?.agentId !== "mistral-vibe") return [];
    const home = yield* HostProcess.HomeDirectory;
    const vibeHome = environment.VIBE_HOME?.trim();
    return [
      {
        dir: NodePath.join(
          vibeHome
            ? NodePath.resolve(expandHomePath(vibeHome, home))
            : NodePath.join(home, ".vibe"),
          "logs",
          "session",
          "unified",
        ),
      },
    ];
  }),
};
