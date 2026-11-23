// @effect-diagnostics nodeBuiltinImport:off - fixtures are a throwaway Vibe home on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { readTranscriptRecords } from "../../usage/usageTranscriptReader.ts";
import {
  parseVibeConfig,
  VIBE_DEFAULT_MODEL,
  vibeJournalState,
  vibeUsageFormat,
} from "./vibeUsage.ts";

let home: string;

function writeFile(relative: string, content: string) {
  const filePath = NodePath.join(home, relative);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, content);
  return filePath;
}

function snapshot(session: string, generation: number, metadata: Record<string, unknown>) {
  writeFile(
    `logs/session/unified/${session}/generations/${String(generation).padStart(16, "0")}/runtime-state.json`,
    JSON.stringify({ session_metadata: metadata }),
  );
}

function completion(
  actionId: string,
  timeMs: number,
  input: number,
  cached: number,
  output: number,
) {
  const result = {
    finish_reason: "stop",
    parts: [{ type: "text", text: "done" }],
    usage: {
      cached_input_tokens: cached,
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    },
  };
  return [
    // Vibe journals the call's result once as an action result, then again as
    // the core input that carries its time. Only the core input counts.
    JSON.stringify({
      type: "action_result",
      sequence: 1,
      payload: {
        action_id: actionId,
        result: { action_id: actionId, result, type: "completion_succeeded" },
        state: "succeeded",
      },
    }),
    JSON.stringify({
      type: "core_input",
      sequence: 2,
      payload: {
        input: {
          command: { action_id: actionId, result, type: "completion_succeeded" },
          determinism: { random_seed: 1, time_unix_ms: timeMs },
          input_id: 1,
        },
      },
    }),
  ].join("\n");
}

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vibe-usage-"));
  writeFile(
    "config.toml",
    [
      'active_model = ""',
      "models = [",
      '    { provider = "mistral", alias = "glm-5-3", name = "zai-glm-5-3", thinking = "high" },',
      "]",
    ].join("\n"),
  );
});

afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

describe("vibe usage", () => {
  it("counts each completion once, priced as the model of the snapshot its journal follows", async () => {
    snapshot("parent", 4, { active_model: "mistral-large-4" });
    snapshot("parent", 9, { active_model: "glm-5-3" });
    const journal = writeFile(
      "logs/session/unified/parent/journal/0000000000000010.jsonl",
      [
        completion("call-1", 1_792_278_041_773, 199_469, 8_320, 243),
        "{not json",
        JSON.stringify({
          type: "core_input",
          payload: { input: { command: { type: "tool_succeeded" } } },
        }),
        "",
      ].join("\n"),
    );

    const parsed = await readTranscriptRecords(journal, vibeUsageFormat);

    expect(parsed?.records).toEqual([
      {
        provider: "vibe",
        timestampMs: 1_792_278_041_773,
        model: "glm-5-3",
        rateModel: "mistral/zai-glm-5-3",
        sessionId: "parent",
        totals: {
          uncachedInputTokens: 199_469 - 8_320,
          cachedInputTokens: 8_320,
          cacheCreationTokens: 0,
          outputTokens: 243,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: JSON.stringify(["vibe", "parent", "call-1"]),
      },
    ]);
  });

  it("uses the snapshot before a journal, not a later one", () => {
    snapshot("parent", 4, { active_model: "mistral-large-4" });
    snapshot("parent", 9, { active_model: "glm-5-3" });

    expect(
      vibeJournalState(
        NodePath.join(home, "logs/session/unified/parent/journal/0000000000000005.jsonl"),
      ),
    ).toMatchObject({ model: "mistral-large-4", rateModel: "mistral/mistral-large-4" });
  });

  it("runs a session with no model on the routed default, then the built-in one", () => {
    snapshot("unset", 1, { active_model: "" });
    const journal = NodePath.join(
      home,
      "logs/session/unified/unset/journal/0000000000000002.jsonl",
    );
    expect(vibeJournalState(journal)).toMatchObject({ model: VIBE_DEFAULT_MODEL });

    writeFile(
      "experiment_eval_cache.json",
      JSON.stringify({
        user: {
          stored_at_timestamp: 1,
          payload: {
            features: {
              vibe_cli_default_routing_model: {
                defaultValue: {
                  active_model: "glm-5-3",
                  model_config: { alias: "glm-5-3", name: "zai-glm-5-3", provider: "mistral" },
                },
              },
              vibe_cli_extra_models: {
                defaultValue: {
                  models: [
                    { alias: "large-preview", name: "mistral-large-4", provider: "mistral" },
                  ],
                },
              },
            },
          },
        },
      }),
    );
    expect(vibeJournalState(journal)).toEqual({
      sessionId: "unset",
      model: "glm-5-3",
      rateModel: "mistral/zai-glm-5-3",
    });
    snapshot("preview", 1, { active_model: "large-preview" });
    expect(
      vibeJournalState(
        NodePath.join(home, "logs/session/unified/preview/journal/0000000000000002.jsonl"),
      ),
    ).toMatchObject({ rateModel: "mistral/mistral-large-4" });
  });

  it("runs subagents on their parent's model and unset sessions on Vibe's default", () => {
    snapshot("parent", 1, { active_model: "glm-5-3" });
    snapshot("child-abc", 5, { active_model: null, parent_session_id: "parent" });
    snapshot("lonely", 1, { active_model: null });

    expect(
      vibeJournalState(
        NodePath.join(home, "logs/session/unified/child-abc/journal/0000000000000006.jsonl"),
      ),
    ).toEqual({ sessionId: "child-abc", model: "glm-5-3", rateModel: "mistral/zai-glm-5-3" });
    expect(
      vibeJournalState(
        NodePath.join(home, "logs/session/unified/lonely/journal/0000000000000002.jsonl"),
      ),
    ).toEqual({
      sessionId: "lonely",
      model: VIBE_DEFAULT_MODEL,
      rateModel: `mistral/${VIBE_DEFAULT_MODEL}`,
    });
  });

  it("reads the active model and aliases from config.toml", () => {
    const config = parseVibeConfig(
      [
        'active_model = "devstral"',
        "models = [",
        '  { alias = "devstral", name = "devstral-2512", provider = "mistral" },',
        '  { provider = "llamacpp", alias = "local", name = "qwen" },',
        "]",
      ].join("\n"),
    );

    expect(config.activeModel).toBe("devstral");
    expect([...config.models]).toEqual([
      ["devstral", { name: "devstral-2512", provider: "mistral" }],
      ["local", { name: "qwen", provider: "llamacpp" }],
    ]);
  });
});
