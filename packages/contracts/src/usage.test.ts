import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ForwardCompatibleArray } from "./baseSchemas.ts";
import { UsageProviderKind, UsageSource } from "./usage.ts";

const decodeProvider = Schema.decodeUnknownSync(UsageProviderKind);
const decodeSource = Schema.decodeUnknownSync(UsageSource);
const oldSources = ForwardCompatibleArray(
  Schema.Struct({ fingerprint: Schema.Struct({ provider: Schema.Literals(["pi", "vibe"]) }) }),
);
const decodeOldSources = Schema.decodeUnknownSync(oldSources);

describe("usage identities", () => {
  it("adds harnesses without renaming existing provider identities", () => {
    for (const provider of [
      "codex",
      "claude",
      "grok",
      "cursor",
      "opencode",
      "pi",
      "muse",
      "antigravity",
      "vibe",
      "qwen-code",
      "kimi",
      "hermes",
    ])
      expect(decodeProvider(provider)).toBe(provider);
  });

  it("decodes legacy sources, and new instance names are additive", () => {
    const legacy = {
      fingerprint: {
        hostId: "host",
        provider: "pi",
        resolvedHomePath: "/pi/sessions",
        volumeId: "1:2",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    };
    expect(decodeSource(legacy)).toEqual(legacy);
    const named = { ...legacy, instanceId: "pi_open_models", displayName: "Pi · Open models" };
    expect(decodeSource(named)).toEqual(named);
    const shared = {
      ...named,
      instances: [
        { instanceId: "first", distinctSessions: 1 },
        { instanceId: "second", displayName: "Second account", distinctSessions: 1 },
      ],
    };
    expect(decodeSource(shared)).toEqual(shared);
    // Older clients drop new providers at the existing forward-compatible array boundary.
    expect(
      decodeOldSources([
        named,
        { ...named, fingerprint: { ...named.fingerprint, provider: "qwen-code" } },
      ]),
    ).toEqual([{ fingerprint: { provider: "pi" } }]);
  });
});
