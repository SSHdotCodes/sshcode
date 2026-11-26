import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Acp from "effect-acp/compat";
import { kimiDiscoveryEnvironment, kimiSupportsMcpDiscovery } from "./kimiMcpDiscovery.ts";

it.effect("enables tool selection for a profile that defers session MCP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped();
      const configPath = path.join(profile, "config.toml");
      const env = { HOME: profile, KIMI_CODE_HOME: profile };
      expect(yield* kimiDiscoveryEnvironment(env)).toBeUndefined();
      yield* fs.writeFileString(configPath, "[mcp]\ndefault_deferred = true\n");
      expect(yield* kimiDiscoveryEnvironment(env)).toEqual({
        ...env,
        KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: "1",
      });
      expect(
        yield* kimiDiscoveryEnvironment({ ...env, KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: "0" }),
      ).toBeUndefined();
      yield* fs.writeFileString(
        configPath,
        "[mcp]\ndefault_deferred = true\n[experimental]\ntool-select = false\n",
      );
      expect(yield* kimiDiscoveryEnvironment(env)).toBeUndefined();
      yield* fs.writeFileString(configPath, "[mcp]\ndefault_deferred = false\n");
      expect(yield* kimiDiscoveryEnvironment(env)).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("offers discovery guidance only to compatible Kimi Code and built-in models", () => {
  const agent = (name: string, version: string): Acp.InitializeResponse => ({
    protocolVersion: 1,
    agentInfo: { name, version },
  });
  const model = "kimi-code/k3.1-pro";
  expect(kimiSupportsMcpDiscovery(agent("Kimi Code CLI", "2.4.1"), model)).toBe(true);
  expect(kimiSupportsMcpDiscovery(agent("Kimi Code CLI", "2.4.0"), model)).toBe(false);
  expect(kimiSupportsMcpDiscovery(agent("Kimi CLI", "2.4.1"), model)).toBe(false);
  expect(kimiSupportsMcpDiscovery(agent("Kimi Code CLI", "2.4.1"), "custom/model")).toBe(false);
});

it.effect("sets the MCP default only in a real SSHCode-owned profile", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const managed = path.join(state, "provider-homes", "kimi-code");
      const personal = yield* fs.makeTempDirectoryScoped();
      const personalConfig = path.join(personal, "config.toml");
      const original = 'default_model = "test-model"\n[mcp]\nstartup_timeout_ms = 500\n';
      yield* fs.makeDirectory(managed, { recursive: true });
      yield* fs.writeFileString(personalConfig, original);
      expect(
        yield* kimiDiscoveryEnvironment({ KIMI_CODE_HOME: personal, HOME: personal }, state),
      ).toBeUndefined();
      const config = path.join(managed, "config.toml");
      yield* fs.symlink(personalConfig, config);
      expect(
        yield* kimiDiscoveryEnvironment({ KIMI_CODE_HOME: managed, HOME: personal }, state),
      ).toBeUndefined();
      expect(yield* fs.readFileString(personalConfig)).toBe(original);
      yield* fs.remove(config);
      yield* fs.writeFileString(config, original);
      const result = yield* kimiDiscoveryEnvironment(
        { KIMI_CODE_HOME: managed, HOME: personal },
        state,
      );
      expect(result?.KIMI_CODE_EXPERIMENTAL_TOOL_SELECT).toBe("1");
      const updated = yield* fs.readFileString(config);
      expect(updated).toContain("default_deferred = true");
      expect(updated).toContain("startup_timeout_ms = 500");
      expect(updated).toContain('default_model = "test-model"');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
