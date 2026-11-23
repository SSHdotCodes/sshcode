// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the Node server with local fixtures.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AcpRegistryOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { toCustomModelSetting } from "@t3tools/shared/model";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  AcpRegistryDriver,
  acpRegistrySnapshotReadiness,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  awaitsRegistryDownload,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";
import { makeAcpRegistryLearnedModelOptions } from "./learnedModelOptions.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    maintenance: () => Effect.die("unused maintenance"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("keeps the custom model display name and options saved by the Settings editor", () => {
    const fastMode = { id: "fast", label: "Fast mode", type: "boolean" } as const;
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [
          toCustomModelSetting({
            slug: "gateway/my-model",
            name: "My model",
            capabilities: { optionDescriptors: [fastMode] },
          }),
        ],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
    });
    const model = snapshot.models.find((entry) => entry.slug === "gateway/my-model");
    expect(model?.name).toBe("My model");
    expect(model?.capabilities?.optionDescriptors).toEqual([fastMode]);
  });

  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).models,
    ).toEqual(provider.models);

    const liveOptions = [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
        currentValue: "high",
      },
    ];
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: liveOptions },
        [],
      ).models,
    ).toMatchObject([
      {
        slug: "probe-model",
        isDefault: true,
        capabilities: { optionDescriptors: [{ id: "effort", currentValue: "high" }] },
      },
    ]);
  });

  it("keeps a model a '!' entry names even when another entry hides its kind", () => {
    const models = [
      { id: "swe-2-high", name: "SWE-2", description: null },
      {
        id: "fusion-claude-opus-5-5-medium-sidekick-swe-2-medium",
        name: "Fusion (A)",
        description: null,
      },
      { id: "fusion-gpt-6-sol-high-sidekick-swe-2-medium", name: "Fusion (B)", description: null },
    ];
    const probed = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "devin",
        hiddenModelPrefixes: [
          "fusion-",
          "!fusion-claude-opus-5-5-medium-sidekick-swe-2-medium",
          "!",
        ],
      }),
      checkedAt: "2026-11-19T01:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "devin",
        version: "3000.1.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models,
          currentModelId: "swe-2-high",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(probed.models.map((model) => model.slug)).toEqual([
      "swe-2-high",
      "fusion-claude-opus-5-5-medium-sidekick-swe-2-medium",
    ]);
  });

  it("leaves out models whose id starts with a hidden prefix", () => {
    const models = [
      { id: "anthropic:claude-opus", name: "Claude Opus", description: null },
      { id: "custom:openrouter:glm", name: "GLM", description: null },
    ];
    const probed = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent", hiddenModelPrefixes: ["anthropic:", ""] }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models,
          currentModelId: "anthropic:claude-opus",
          configOptions: [],
          sessionManagement: {
            canList: false,
            canLoad: false,
            canResume: false,
            canLogout: false,
            canDelete: false,
            canConfigureProviders: false,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(probed.models.map((model) => model.slug)).toEqual(["custom:openrouter:glm"]);
    // A session that reports the full list again does not bring them back.
    expect(
      applyAcpRegistryLiveConfiguration(
        probed,
        { models, currentModelId: "custom:openrouter:glm", configOptions: [] },
        [],
        probed.models,
        ["anthropic:"],
      ).models.map((model) => model.slug),
    ).toEqual(["custom:openrouter:glm"]);
    // Without the setting every advertised model is offered.
    expect(
      applyAcpRegistryLiveConfiguration(
        probed,
        { models, currentModelId: "custom:openrouter:glm", configOptions: [] },
        [],
      ).models.map((model) => model.slug),
    ).toEqual(["anthropic:claude-opus", "custom:openrouter:glm"]);
    // Hiding everything the agent offers leaves nothing to pick, not a "Default" that
    // would run the hidden model.
    expect(
      applyAcpRegistryLiveConfiguration(
        probed,
        {
          models: [models[0]!],
          currentModelId: "anthropic:claude-opus",
          configOptions: [],
        },
        [],
        [],
        ["anthropic:"],
      ).models,
    ).toEqual([]);
  });

  it("keeps model-specific session options on the model that reported them", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
    });
    const effort = {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      options: [{ id: "high", label: "High" }],
      currentValue: "high",
    };
    const sharedMode = {
      id: "mode",
      label: "Mode",
      type: "select" as const,
      options: [{ id: "ask", label: "Ask" }],
      currentValue: "ask",
    };
    const twoModelList = [
      { id: "glm", name: "GLM", description: null },
      { id: "opus", name: "Opus", description: null },
    ];
    const afterGlm = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: twoModelList,
        currentModelId: "glm",
        configOptions: [effort, sharedMode],
        modelOptionIds: ["effort"],
      },
      [],
    );
    expect(afterGlm.models.find((model) => model.slug === "glm")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "effort" }, { id: "mode" }] },
    });
    expect(
      afterGlm.models.find((model) => model.slug === "opus")?.capabilities?.optionDescriptors ?? [],
    ).toEqual([sharedMode]);
    // A later session on another model keeps the options learned for this one.
    const afterOpus = applyAcpRegistryLiveConfiguration(
      afterGlm,
      {
        models: twoModelList,
        currentModelId: "opus",
        configOptions: [{ ...effort, id: "thinking" }, sharedMode],
        modelOptionIds: ["thinking"],
      },
      [],
    ).models;
    expect(afterOpus.find((model) => model.slug === "glm")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "mode" }, { id: "effort" }] },
    });
    expect(afterOpus.find((model) => model.slug === "opus")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "thinking" }, { id: "mode" }] },
    });

    // Other models take the levels they advertise in `_meta`.
    const thoughtLevel = {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    };
    const advertised = applyAcpRegistryLiveConfiguration(
      provider,
      normalizeAcpRegistryLiveConfiguration([thoughtLevel], undefined, {
        currentModelId: "opus",
        availableModels: [
          { modelId: "opus", name: "Opus" },
          {
            modelId: "haiku",
            name: "Haiku",
            _meta: { reasoningEfforts: [{ value: "low", label: "Low" }], reasoningEffort: "low" },
          },
          { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
        ],
      }),
      [],
    ).models.map((model) => model.capabilities?.optionDescriptors ?? []);
    expect(advertised).toEqual([
      [{ ...effort, role: "reasoning" }],
      [
        {
          ...effort,
          role: "reasoning",
          options: [{ id: "low", label: "Low" }],
          currentValue: "low",
        },
      ],
      [],
    ]);
  });

  it("gives each model the options the probe read for it, and none when it has none", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-11-18T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
    });
    const level = (values: ReadonlyArray<string>) => ({
      id: "thought_level",
      label: "Thinking",
      type: "select" as const,
      role: "reasoning" as const,
      options: values.map((id) => ({ id, label: id })),
      currentValue: values[0]!,
    });
    const mode = {
      id: "mode",
      label: "Mode",
      type: "select" as const,
      options: [{ id: "smart", label: "Smart" }],
      currentValue: "smart",
    };
    const live = {
      models: [
        { id: "swe-2-high", name: "SWE-2", description: null },
        {
          id: "opus-medium",
          name: "Opus",
          description: null,
          options: [level(["low", "max"])],
        },
        { id: "adaptive", name: "Adaptive", description: null, options: [] },
      ],
      currentModelId: "swe-2-high",
      configOptions: [level(["medium", "high", "max"]), mode],
      modelOptionIds: ["thought_level"],
    };
    // An earlier session left an effort on Adaptive; the probe now says it has none.
    const earlier = {
      ...provider,
      models: [
        {
          slug: "adaptive",
          name: "Adaptive",
          isCustom: false,
          capabilities: { optionDescriptors: [level(["high"])] },
        },
      ],
    } as ServerProvider;
    const models = applyAcpRegistryLiveConfiguration(earlier, live, []).models;
    expect(models.map((model) => model.capabilities?.optionDescriptors ?? [])).toEqual([
      [level(["medium", "high", "max"]), mode],
      [mode, level(["low", "max"])],
      [mode],
    ]);
  });

  it("keeps what an earlier check read for models a probe ran out of time on", () => {
    const level = {
      id: "thought_level",
      label: "Thinking",
      type: "select" as const,
      role: "reasoning" as const,
      options: [{ id: "low", label: "low" }],
      currentValue: "low",
    };
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-11-18T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
      previousModels: [
        {
          slug: "late",
          name: "Late",
          isCustom: false,
          capabilities: { optionDescriptors: [level] },
        },
      ],
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [
            { id: "now", name: "Now", description: null },
            { id: "late", name: "Late", description: null },
            { id: "read", name: "Read", description: null, options: [] },
          ],
          currentModelId: "now",
          configOptions: [{ ...level, id: "thought_level" }],
          modelOptionIds: ["thought_level"],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.models.map((model) => model.capabilities?.optionDescriptors ?? [])).toEqual([
      [level],
      [level],
      [],
    ]);
  });

  it("maps registry inspection status to provider readiness", () => {
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
      }),
    ).toEqual({ installed: true, version: "1.2.3", status: "ready" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
        runner: "npx",
      }),
    ).toMatchObject({ installed: false, version: "1.2.3", status: "error" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        version: null,
        distribution: "local",
      }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Local ACP executable is not available on this environment's PATH.",
    });

    expect(
      acpRegistrySnapshotReadiness({
        status: "unprepared",
        agentId: "zed-agent",
        version: "2.0.0",
        distribution: "binary",
      }),
    ).toMatchObject({ installed: false, version: "2.0.0", status: "warning" });

    expect(
      acpRegistrySnapshotReadiness({ status: "failed", message: "Registry unavailable." }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Registry unavailable.",
    });
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("downloads a registry agent that settings name but this machine never prepared", () =>
    Effect.gen(function* () {
      const prepared: Array<string> = [];
      let downloaded = false;
      const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
        ...catalogWithInspection({
          status: "unprepared",
          agentId: "devin",
          version: "3000.1.0",
          distribution: "binary",
        }),
        prepare: (input) =>
          Effect.sync(() => {
            prepared.push(input.agentId);
            downloaded = true;
            return {
              agentId: input.agentId,
              version: "3000.1.0",
              distribution: "binary" as const,
              prepared: true as const,
            };
          }),
        inspect: () =>
          Effect.sync(() =>
            downloaded
              ? {
                  status: "ready" as const,
                  agentId: "devin",
                  version: "3000.1.0",
                  distribution: "binary" as const,
                }
              : {
                  status: "unprepared" as const,
                  agentId: "devin",
                  version: "3000.1.0",
                  distribution: "binary" as const,
                },
          ),
      };
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings: decodeSettings({ agentId: "devin" }),
          cwd: "/workspace",
          environment: {},
        },
        () =>
          Effect.succeed({
            probe: {
              instanceId: identity.instanceId,
              ready: true as const,
              icon: null,
              authMethods: [],
              models: [{ id: "swe-2", name: "SWE-2", description: null }],
              currentModelId: "swe-2",
              configOptions: [],
              sessionManagement: noSessionManagement,
            },
            slashCommands: [],
            skills: [],
          }),
      ).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

      expect(prepared).toEqual(["devin"]);
      expect(snapshot).toMatchObject({ installed: true, models: [{ slug: "swe-2" }] });
    }),
  );

  it("runs the background check for an agent that only awaits its download", () => {
    const readiness = (inspection: AcpRegistrySupport.AcpRegistryInspection) =>
      buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({ agentId: "devin" }),
        checkedAt: "2026-11-19T01:00:00.000Z",
        inspection,
      });
    expect(
      awaitsRegistryDownload(
        readiness({
          status: "unprepared",
          agentId: "devin",
          version: "3000.1.0",
          distribution: "binary",
        }),
      ),
    ).toBe(true);
    expect(awaitsRegistryDownload(readiness({ status: "unconfigured" }))).toBe(false);
    expect(
      awaitsRegistryDownload(readiness({ status: "unsupported", agentId: "devin", version: "1" })),
    ).toBe(false);
    expect(
      awaitsRegistryDownload(
        readiness({
          status: "missing_runner",
          agentId: "devin",
          version: "1",
          distribution: "npx",
          runner: "npx",
        }),
      ),
    ).toBe(false);
  });

  it.effect("says why a registry agent could not be downloaded", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings: decodeSettings({ agentId: "devin" }),
          cwd: "/workspace",
          environment: {},
        },
        () => Effect.die("no probe before the agent is downloaded"),
      ).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "unprepared",
            agentId: "devin",
            version: "3000.1.0",
            distribution: "binary",
          }),
          prepare: () =>
            Effect.fail(
              new AcpRegistrySupport.AcpRegistryError({
                reason: "install_failed",
                detail: "The download was interrupted.",
              }),
            ),
        }),
      );

      expect(snapshot).toMatchObject({ installed: false, status: "error" });
      expect(snapshot.message).toContain("Could not download ACP Registry agent 'devin'");
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );
});

const fakeAgentSource = `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const switchLog = process.argv[3];
const configFor = (id) => [
  { type: "select", category: "model", id: "model", name: "Model", currentValue: id,
    options: JSON.parse(readFileSync(process.argv[2], "utf8")).map(value => ({value, name: value})) },
  ...(id.startsWith("effort") ? [{ type: "select", category: "thought_level", id: "effort", name: "Effort",
    currentValue: "high", options: [{ value: "high", name: "High" }] }] : []),
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    const modelIds = JSON.parse(readFileSync(process.argv[2], "utf8"));
    send({
      id,
      result: {
        sessionId: "probe-session",
        ...(switchLog ? { configOptions: configFor(modelIds[0]) } : {}),
        models: {
          currentModelId: modelIds[0],
          availableModels: modelIds.map((modelId) => ({ modelId, name: modelId })),
        },
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId: "probe-session",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    });
  } else if (switchLog && method === "session/set_config_option") {
    appendFileSync(switchLog, params.value + "\\n");
    send({ id, result: { configOptions: configFor(params.value) } });
  } else {
    send({ id, result: {} });
  }
});
`;

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(AcpRegistryRuntimeCoordinator.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(driverLayer, { excludeTestServices: true })("AcpRegistryDriver", (it) => {
  it.effect("resumes Devin discovery from disk after restarting the driver", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const agent = `${directory}/probe.mjs`;
      const models = `${directory}/models.json`;
      const switches = `${directory}/switches.log`;
      yield* fs.writeFileString(agent, fakeAgentSource);
      const check = (catalog: string[], target: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* fs.writeFileString(models, JSON.stringify(catalog));
            yield* fs.writeFileString(switches, "");
            const instance = yield* AcpRegistryDriver.create({
              instanceId: ProviderInstanceId.make("acpRegistry_devin_restart_test"),
              displayName: "Devin",
              enabled: true,
              environment: [],
              config: decodeSettings({ agentId: "devin" }),
            }).pipe(
              Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
                ...catalogWithInspection({
                  status: "ready",
                  agentId: "devin",
                  version: "1",
                  distribution: "npx",
                }),
                resolve: () =>
                  Effect.succeed({
                    distribution: "local" as const,
                    spawn: { command: process.execPath, args: [agent, models, switches] },
                  }),
                maintenance: () =>
                  Effect.succeed({
                    provider: ProviderDriverKind.make("acpRegistry"),
                    packageName: null,
                    update: null,
                    latestVersion: null,
                  }),
              }),
            );
            const discovered = yield* instance.snapshot.streamChanges.pipe(
              Stream.filter((snapshot) =>
                snapshot.models.some(
                  (model) =>
                    model.slug === target &&
                    model.capabilities?.optionDescriptors?.some((option) => option.id === "effort"),
                ),
              ),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* instance.snapshot.refresh;
            yield* Fiber.join(discovered);
            return (yield* fs.readFileString(switches)).trim().split("\n");
          }),
        );
      expect((yield* check(["adaptive", "empty", "effort-a"], "effort-a"))[0]).toBe("empty");
      expect((yield* check(["adaptive", "empty", "effort-a", "effort-b"], "effort-b"))[0]).toBe(
        "effort-b",
      );
    }),
  );

  it.effect("keeps options learned for each model across a refresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a", "model-b"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
          // The driver checks for updates while publishing discovery.
          maintenance: () =>
            Effect.succeed({
              provider: ProviderDriverKind.make("acpRegistry"),
              packageName: null,
              update: null,
              latestVersion: null,
            }),
        }),
      );
      const effortBySlug = (snapshot: ServerProvider) =>
        snapshot.models
          .map(
            (model) =>
              `${model.slug}:${(model.capabilities?.optionDescriptors ?? []).map((option) => option.id).join("+")}`,
          )
          .join();
      const waitFor = (expected: string) =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => effortBySlug(snapshot) === expected),
          Stream.runHead,
        );
      const session = (currentModelId: string) =>
        normalizeAcpRegistryLiveConfiguration(
          [
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
          undefined,
          {
            currentModelId,
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b" },
            ],
          },
        );

      const probed = yield* waitFor("model-a:,model-b:").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const learned = yield* waitFor("model-a:effort,model-b:effort").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(identity.instanceId, session("model-b"));
      yield* coordinator.publishLiveConfiguration(identity.instanceId, session("model-a"));
      yield* Fiber.join(learned);

      yield* instance.snapshot.refresh;
      expect(effortBySlug(yield* instance.snapshot.getSnapshot)).toBe(
        "model-a:effort,model-b:effort",
      );

      const config = session("model-b");
      const publishModeOnly = (currentModelId: string) =>
        Effect.gen(function* () {
          const changed = yield* instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) =>
              snapshot.models.some(
                (model) =>
                  model.isDefault &&
                  model.slug === currentModelId &&
                  model.capabilities?.optionDescriptors?.some((option) => option.id === "mode"),
              ),
            ),
            Stream.runHead,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* coordinator.publishLiveConfiguration(identity.instanceId, {
            ...config,
            currentModelId,
            models: [...config.models, { id: "model-c", name: "model-c", description: null }],
            configOptions: [{ id: "mode", label: "Mode", type: "boolean" }],
            modelOptionIds: [],
          });
          return Option.getOrThrow(yield* Fiber.join(changed));
        });
      const partial = yield* publishModeOnly("model-b");
      expect(
        partial.models
          .find((model) => model.slug === "model-b")
          ?.capabilities?.optionDescriptors?.map((option) => option.id),
      ).toEqual(["mode", "effort"]);
      yield* publishModeOnly("model-c");
      const restored = yield* makeAcpRegistryLearnedModelOptions({
        instanceId: identity.instanceId,
        cacheDir: (yield* ProviderHost.ProviderHost).paths.providerStatusCacheDir,
      });
      expect(yield* restored.readModelIds).toEqual(new Set(["model-a", "model-b"]));
    }),
  );

  it.effect("drops cached and session-reported models when its caches are invalidated", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
          // The driver checks for updates while publishing discovery.
          maintenance: () =>
            Effect.succeed({
              provider: ProviderDriverKind.make("acpRegistry"),
              packageName: null,
              update: null,
              latestVersion: null,
            }),
        }),
      );
      const modelSlugs = instance.snapshot.streamChanges.pipe(
        Stream.map((snapshot) => snapshot.models.map((model) => model.slug)),
      );
      const waitForModels = (expected: ReadonlyArray<string>) =>
        modelSlugs.pipe(
          Stream.filter((slugs) => slugs.join() === expected.join()),
          Stream.runHead,
        );

      const probed = yield* waitForModels(["old-model"]).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        normalizeAcpRegistryLiveConfiguration([], undefined, {
          currentModelId: "old-model",
          availableModels: [{ modelId: "old-model", name: "old-model" }],
        }),
      );
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "new-model"]));

      const refreshed = yield* waitForModels(["old-model", "new-model"]).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      expect(Option.isSome(yield* Fiber.join(refreshed))).toBe(true);
    }),
  );

  it.effect("publishes Devin daily and weekly usage limits on the ACP registry snapshot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-devin-limits-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      const cliCacheDir = path.join(directory, "devin", "cli");
      yield* fileSystem.makeDirectory(cliCacheDir, { recursive: true });
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["swe-2-high"]));

      const nowSecs = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      // Minimal scrubbed protobuf UserStatus -> PlanStatus(daily=100%, weekly=94%, reset unix timestamps).
      const varint = (value: bigint) => {
        const bytes: number[] = [];
        let remaining = value;
        while (remaining >= 0x80n) {
          bytes.push(Number((remaining & 0x7fn) | 0x80n));
          remaining >>= 7n;
        }
        bytes.push(Number(remaining));
        return bytes;
      };
      const field = (num: number, value: bigint) => [...varint(BigInt(num << 3)), ...varint(value)];
      const planStatus = [
        ...field(14, 100n),
        ...field(15, 94n),
        ...field(17, 1795248000n),
        ...field(18, 1795334400n),
      ];
      const userStatus = Uint8Array.from([
        ...varint(BigInt((13 << 3) | 2)),
        ...varint(BigInt(planStatus.length)),
        ...planStatus,
      ]);
      yield* fileSystem.writeFileString(
        path.join(cliCacheDir, "user_status.test0001.bin"),
        JSON.stringify({
          version: 1,
          identity_digest: "00000000000000000000000000000000",
          fetched_at_secs: nowSecs - 5,
          payload: Buffer.from(userStatus).toString("base64"),
        }),
      );

      const instance = yield* AcpRegistryDriver.create({
        instanceId: ProviderInstanceId.make("acpRegistry_devin"),
        displayName: "Devin",
        enabled: true,
        environment: [{ name: "XDG_CACHE_HOME", value: directory, sensitive: false }],
        config: decodeSettings({ agentId: "devin" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "devin",
            version: "3000.14.30821",
            distribution: "binary",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "local" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
          maintenance: () =>
            Effect.succeed({
              provider: ProviderDriverKind.make("acpRegistry"),
              packageName: null,
              update: null,
              latestVersion: null,
            }),
        }),
      );

      const withLimits = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => (snapshot.usageLimits?.windows.length ?? 0) === 2),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      const current = yield* instance.snapshot.getSnapshot;
      const snapshot =
        (current.usageLimits?.windows.length ?? 0) === 2
          ? current
          : yield* instance.snapshot.refresh.pipe(
              Effect.andThen(Fiber.join(withLimits)),
              Effect.map(Option.getOrThrow),
            );
      expect(snapshot.usageLimits?.windows).toEqual([
        {
          id: "daily",
          kind: "session",
          label: "Daily",
          usedPercent: 0,
          windowDurationMins: 1440,
          resetsAt: "2026-11-21T08:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 6,
          windowDurationMins: 10080,
          resetsAt: "2026-11-22T08:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("publishes probeFailed with a notice when Devin usage limits cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-devin-fail-" });
      const instance = yield* AcpRegistryDriver.create({
        instanceId: ProviderInstanceId.make("acpRegistry_devin"),
        displayName: "Devin",
        enabled: true,
        environment: [{ name: "XDG_CACHE_HOME", value: directory, sensitive: false }],
        config: decodeSettings({ agentId: "devin" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "missing_runner",
            agentId: "devin",
            version: "3000.14.30821",
            distribution: "binary",
            runner: "devin",
          }),
          maintenance: () =>
            Effect.succeed({
              provider: ProviderDriverKind.make("acpRegistry"),
              packageName: null,
              update: null,
              latestVersion: null,
            }),
        }),
      );

      const withNotice = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.usageLimits?.unavailable?.reason === "probeFailed"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      const current = yield* instance.snapshot.getSnapshot;
      const snapshot =
        current.usageLimits?.unavailable?.reason === "probeFailed"
          ? current
          : yield* instance.snapshot.refresh.pipe(
              Effect.andThen(Fiber.join(withNotice)),
              Effect.map(Option.getOrThrow),
            );
      expect(snapshot.usageLimits?.unavailable).toEqual({
        reason: "probeFailed",
        message: "Devin could not read usage limits.",
      });
    }),
  );
});
