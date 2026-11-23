import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { ProviderUsageInstance } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { qwenUsageReader } from "./qwenUsage.ts";
import { kimiUsageReader } from "./kimiUsage.ts";
import { vibeUsageReader } from "./vibeUsage.ts";

const readers = [vibeUsageReader, qwenUsageReader, kimiUsageReader].filter(
  (reader) => reader.kind === "transcripts",
);
const decodeConfig = Schema.decodeUnknownSync(AcpRegistrySettings);

function instance(
  agentId: string | undefined,
  suffix = "one",
): ProviderUsageInstance<AcpRegistrySettings> {
  return {
    instanceId: ProviderInstanceId.make(`registry-${suffix}`),
    configured: true,
    config: agentId === undefined ? undefined : decodeConfig({ agentId }),
    // Every process inherits these variables. Selecting by the presence of a home is wrong.
    environment: {
      QWEN_HOME: `~/qwen-${suffix}`,
      KIMI_SHARE_DIR: `~/kimi-${suffix}`,
      VIBE_HOME: `~/vibe-${suffix}`,
    },
  };
}

describe("registry usage composition", () => {
  it.effect("reads only the selected agent's home, with isolated Kimi instances", () =>
    Effect.gen(function* () {
      for (const [agentId, provider, expected] of [
        ["qwen-code", "qwen-code", "/sandbox/qwen-one/projects"],
        ["kimi", "kimi", "/sandbox/kimi-one/sessions"],
        ["mistral-vibe", "vibe", "/sandbox/vibe-one/logs/session/unified"],
      ] as const) {
        const sources = yield* Effect.forEach(readers, (reader) =>
          reader
            .directories(instance(agentId))
            .pipe(Effect.map((dirs) => ({ provider: reader.provider, dirs }))),
        );
        expect(sources.filter((source) => source.dirs.length > 0)).toEqual([
          {
            provider,
            dirs: [{ dir: expected, ...(provider === "kimi" ? { fileName: "wire.jsonl" } : {}) }],
          },
        ]);
      }
      const kimi = readers.find((reader) => reader.provider === "kimi")!;
      expect(yield* kimi.directories(instance("kimi", "two"))).toEqual([
        { dir: "/sandbox/kimi-two/sessions", fileName: "wire.jsonl" },
      ]);
      for (const config of [undefined, "hermes", "other-agent", ""]) {
        for (const reader of readers)
          expect(yield* reader.directories(instance(config))).toEqual([]);
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/sandbox"),
    ),
  );
});
