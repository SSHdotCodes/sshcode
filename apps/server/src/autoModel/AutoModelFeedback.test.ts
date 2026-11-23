import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  AuthSettingsWriteScope,
  ProviderInstanceId,
  ThreadId,
  type AutoModelFeedback as Feedback,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as AutoModelFeedback from "./AutoModelFeedback.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";

const session: AuthenticatedSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "one-time-token",
  method: "browser-session-cookie",
  scopes: [AuthSettingsWriteScope],
};
const record: Feedback = {
  threadId: ThreadId.make("new-chat"),
  at: "2026-11-12T12:00:00.000Z",
  suggestedTier: "fast",
  confidence: 0.85,
  suggestedModel: { instanceId: ProviderInstanceId.make("codex"), model: "small" },
  shown: true,
  accepted: true,
  chosenModel: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "small",
    options: [{ id: "reasoningEffort", value: "low" }],
  },
};
const configLayer = ServerConfig.layerTest("/private/tmp", { prefix: "auto-model-feedback-" });
const testLayer = AutoModelFeedback.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const service = yield* AutoModelFeedback.AutoModelFeedback;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return { service, fs, file: path.join(config.stateDir, "auto-model-feedback.ndjson") };
});

describe("AutoModelFeedback", () => {
  it.effect("writes only the outcome fields and preserves usual effort", () =>
    Effect.gen(function* () {
      const { service, fs, file } = yield* fixture;
      const withPrompt = { ...record, prompt: "private prompt" };
      yield* service.record(session, withPrompt);
      const contents = yield* fs.readFileString(file);
      expect(contents.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(contents)).toEqual(record);
      expect(contents).not.toContain("private prompt");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("refuses guests and non-owner scopes without creating a file", () =>
    Effect.gen(function* () {
      const { service, fs, file } = yield* fixture;
      for (const caller of [
        { ...session, subject: "guest:share" },
        { ...session, subject: "mcp-client" },
        { ...session, scopes: [] },
      ]) {
        const denied = yield* service.record(caller, record).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("serializes concurrent appends and caps records across a service restart", () =>
    Effect.gen(function* () {
      const { service, fs, file } = yield* fixture;
      const oldLines =
        Array.from({ length: 2000 }, (_, index) =>
          JSON.stringify({ ...record, threadId: `old-${index}` }),
        ).join("\n") + "\n";
      yield* fs.writeFileString(file, oldLines);
      yield* Effect.all(
        Array.from({ length: 4 }, (_, index) =>
          service.record(session, { ...record, threadId: ThreadId.make(`new-${index}`) }),
        ),
        { concurrency: "unbounded" },
      );
      const restarted = yield* AutoModelFeedback.AutoModelFeedback.pipe(
        Effect.provide(Layer.fresh(AutoModelFeedback.layer)),
      );
      yield* restarted.record(session, { ...record, threadId: ThreadId.make("after-restart") });
      const lines = (yield* fs.readFileString(file))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Feedback);
      expect(lines).toHaveLength(2000);
      expect(lines[0]?.threadId).toBe("old-5");
      expect(
        lines
          .slice(-5)
          .map((line) => line.threadId)
          .sort(),
      ).toEqual(["after-restart", "new-0", "new-1", "new-2", "new-3"]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("does not fail an owner request when the log cannot be written", () =>
    Effect.gen(function* () {
      const { service, fs, file } = yield* fixture;
      yield* fs.makeDirectory(file);
      yield* service.record(session, record);
      expect((yield* fs.stat(file)).type).toBe("Directory");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
