import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  nativeHarnessModelSelection,
  resolveNewChatModelSelection,
  resolveNewThreadEnvMode,
  resolveProjectFileBackedSetting,
  resolveProjectSettings,
  resolveWorktreeCleanup,
  withProjectSettingsOverrides,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveProjectSettings", () => {
  it("inherits every scopable key when the project has no overrides", () => {
    const resolved = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId);
    expect(resolved.settings).toBe(DEFAULT_SERVER_SETTINGS);
    for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
      expect(resolved.sources[key]).toBe("environment");
    }
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it("ignores an override left undefined by a forward-compatible decode", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      },
      projectId,
    );
    expect(resolved.settings.defaultRuntimeMode).toBe("full-access");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(
      hasProjectSettingsOverrides({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      }),
    ).toBe(false);
  });

  it("treats a null project like an absent one before the shell snapshot arrives", () => {
    // The mobile new-task flow resolves settings while its selected project is
    // still null; reading the aggregate's legacy fields off null crashed launch.
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null, null).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: false, sidebarAutoSettleAfterDays: null },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultAutoPull).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultThreadEnvMode).toBe(settings.defaultThreadEnvMode);
    expect(resolved.sources.defaultAutoPull).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.defaultAutoPull).toBe(true);
  });

  it("keeps the environment text generation model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: {
        [projectId]: { textGenerationModelSelection: disabledSelection },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.textGenerationModelSelection).toEqual(
      settings.textGenerationModelSelection,
    );
    expect(resolved.sources.textGenerationModelSelection).toBe("environment");
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const aggregateModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
    const project = {
      defaultModelSelection: aggregateModel,
      defaultThreadEnvMode: "local" as const,
    };
    const unfolded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.settings.defaultThreadEnvMode).toBe("local");
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    // A stored override still beats the aggregate before the fold.
    const overridden = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultThreadEnvMode).toBe("worktree");
    // After the fold a reset in the record wins over the stale aggregate.
    const folded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: disabledSelection } },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });

  it("moves text generation off an instance the project turned off", () => {
    const codex = ProviderInstanceId.make("codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [codex]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.textGenerationModelSelection,
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("falls back to a configured instance when every built-in one is off for the project", () => {
    const codex = ProviderInstanceId.make("codex");
    const codexWork = ProviderInstanceId.make("codex_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      providerInstances: { [codexWork]: { driver: ProviderDriverKind.make("codex"), config: {} } },
      projectSettingsOverrides: {
        [projectId]: {
          providerInstances: {
            [codex]: { enabled: false },
            [ProviderInstanceId.make("claudeAgent")]: { enabled: false },
          },
        },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(codexWork);
  });
});

describe("resolveProjectSettings with a t3.json", () => {
  it("walks project override, environment value, file, then built-in for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      },
      projectId,
      null,
      file,
    );
    expect(fromOverride.settings.defaultThreadEnvMode).toBe("local");
    expect(fromOverride.sources.defaultThreadEnvMode).toBe("project");

    const fromEnvironment = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      projectId,
      null,
      file,
    );
    expect(fromEnvironment.settings.defaultThreadEnvMode).toBe("local");
    expect(fromEnvironment.sources.defaultThreadEnvMode).toBe("environment");

    const fromFile = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file);
    expect(fromFile.settings.defaultThreadEnvMode).toBe("worktree");
    expect(fromFile.sources.defaultThreadEnvMode).toBe("t3.json");

    const builtIn = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, null);
    expect(builtIn.settings.defaultThreadEnvMode).toBe("local");
    expect(builtIn.sources.defaultThreadEnvMode).toBe("environment");
    // A stored null override defers like an unset one and is not reported
    // as the project's value.
    const nullOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: null } as never },
      },
      projectId,
      null,
      file,
    );
    expect(nullOverride.settings.defaultThreadEnvMode).toBe("worktree");
    expect(nullOverride.sources.defaultThreadEnvMode).toBe("t3.json");
    // A file that does not mention the key leaves the source alone too.
    expect(
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {}).sources
        .defaultThreadEnvMode,
    ).toBe("environment");
  });

  it("resolves one key from the settings tier, then the file, then the built-in", () => {
    expect(
      resolveProjectFileBackedSetting("worktreeSubmodules", "none", {
        worktreeSubmodules: "top-level",
      }),
    ).toEqual({ value: "none", source: "environment" });
    expect(
      resolveProjectFileBackedSetting("worktreeSubmodules", null, {
        worktreeSubmodules: "top-level",
      }),
    ).toEqual({ value: "top-level", source: "t3.json" });
    expect(resolveProjectFileBackedSetting("worktreeSubmodules", null, null)).toEqual({
      value: "recursive",
      source: "environment",
    });
  });

  it("leaves settings untouched when no file is passed", () => {
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });
});

describe("resolveNewThreadEnvMode", () => {
  const worktreeEnvironment = resolveProjectSettings(
    { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    projectId,
    null,
    null,
  );
  const newProject = {
    projectSettings: worktreeEnvironment,
    workspaceRoot: "/data/projects/pinball-stats",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: false,
  };

  it("starts a new project's first thread in its checkout", () => {
    expect(resolveNewThreadEnvMode(newProject)).toBe("local");
    expect(
      resolveNewThreadEnvMode({
        ...newProject,
        workspaceRoot: "C:\\Data\\Projects\\Pinball-Stats",
        newProjectsRoot: "c:/data/projects",
      }),
    ).toBe("local");
  });

  it("keeps the configured default once the project has a thread or is not a new project", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectHasThreads: true })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects" })).toBe(
      "worktree",
    );
    expect(
      resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects/a/nested" }),
    ).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects-old/a" })).toBe(
      "worktree",
    );
    expect(resolveNewThreadEnvMode({ ...newProject, newProjectsRoot: undefined })).toBe("worktree");
  });

  it("lets a project override, or a t3.json the environment defers to, keep worktree mode", () => {
    for (const projectSettings of [
      resolveProjectSettings(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
        },
        projectId,
        null,
        null,
      ),
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {
        defaultThreadEnvMode: "worktree",
      }),
    ]) {
      expect(resolveNewThreadEnvMode({ ...newProject, projectSettings })).toBe("worktree");
    }
  });
});

describe("projectSettingsOverrides patches", () => {
  it("replaces a project's entry, removes it with null, and drops empty entries", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultAutoPull: false },
      },
    });
    expect(hasProjectSettingsOverrides(first)).toBe(true);
    const replaced = applyServerSettingsPatch(first, {
      projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
    });
    expect(replaced.projectSettingsOverrides[projectId]).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(replaced.projectSettingsOverrides[otherProjectId]).toEqual({ defaultAutoPull: false });
    const emptied = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(emptied.projectSettingsOverrides[projectId]).toBeUndefined();
    const removed = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(removed.projectSettingsOverrides).toEqual({
      [otherProjectId]: { defaultAutoPull: false },
    });
    expect(hasProjectSettingsOverrides(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("derives the legacy per-key maps from the generic record", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultProjectScripts: [] },
      },
    });
    expect(settings.projectAutoPullOverrides).toEqual({ [projectId]: true });
    expect(settings.projectAgentBrowserAccessOverrides).toEqual({ [projectId]: false });
    expect(settings.projectScriptOverrides).toEqual({ [otherProjectId]: [] });
  });

  it("translates legacy per-key patches into the generic record", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAutoPullOverrides: { [projectId]: true },
      projectAgentBrowserAccessOverrides: { [projectId]: false, [otherProjectId]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
      [otherProjectId]: { enableAgentBrowserAccess: true },
    });
    const cleared = applyServerSettingsPatch(written, {
      projectAgentBrowserAccessOverrides: { [projectId]: null, [otherProjectId]: null },
    });
    expect(cleared.projectSettingsOverrides).toEqual({ [projectId]: { defaultAutoPull: true } });
  });

  it("lets a canonical entry win over a legacy map for the same project", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    // The canonical entry omits defaultAutoPull to clear it; the stale legacy
    // map in the same patch must not put it back.
    const next = applyServerSettingsPatch(current, {
      projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      projectAutoPullOverrides: { [projectId]: true, [otherProjectId]: false },
    });
    expect(next.projectSettingsOverrides).toEqual({
      [projectId]: { defaultThreadEnvMode: "local" },
      [otherProjectId]: { defaultAutoPull: false },
    });
  });

  it("builds replacement entries and clears individual keys", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
      },
    });
    expect(clearProjectSettingsOverrides(settings, projectId, ["defaultAutoPull"])).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(
      clearProjectSettingsOverrides(settings, projectId, [
        "defaultAutoPull",
        "enableAgentBrowserAccess",
      ]),
    ).toBeNull();
    expect(clearProjectSettingsOverrides(settings, otherProjectId, ["defaultAutoPull"])).toBeNull();
    expect(withProjectSettingsOverrides(settings, projectId, null)).toEqual({});
    expect(
      withProjectSettingsOverrides(settings, otherProjectId, { defaultThreadEnvMode: "worktree" }),
    ).toEqual({
      ...settings.projectSettingsOverrides,
      [otherProjectId]: { defaultThreadEnvMode: "worktree" },
    });
  });
});

describe("resolveWorktreeCleanup", () => {
  it("inherits machine rules, disables one project and keeps custom rules isolated", () => {
    const machine = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: {
        worktreeAfterDays: 8,
        worktreeSettledAfterDays: 2,
        worktreeKeepWhen: "any-local-files",
        worktreeOnDelete: true,
        logsAfterDays: 3,
      },
    });
    const inherited = resolveWorktreeCleanup(machine, projectId);
    expect(inherited).toMatchObject({
      worktreeSettledAfterDays: 2,
      worktreeKeepWhen: "any-local-files",
    });
    const off = applyServerSettingsPatch(machine, {
      projectSettingsOverrides: {
        [projectId]: { worktreeCleanup: { mode: "off" } },
      },
    });
    expect(resolveWorktreeCleanup(off, projectId)).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
    });
    expect(resolveWorktreeCleanup(off, otherProjectId)).toEqual(inherited);
    const custom = applyServerSettingsPatch(off, {
      projectSettingsOverrides: {
        [projectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: { ...inherited, worktreeAfterDays: 15, worktreeSettledAfterDays: 0 },
          },
        },
      },
    });
    expect(resolveWorktreeCleanup(custom, projectId).worktreeAfterDays).toBe(15);
    expect(resolveWorktreeCleanup(custom, projectId).worktreeSettledAfterDays).toBe(0);
    expect(resolveWorktreeCleanup(custom, otherProjectId)).toEqual(inherited);
    expect(custom.storageCleanup.logsAfterDays).toBe(3);
    const reset = applyServerSettingsPatch(custom, {
      projectSettingsOverrides: {
        [projectId]: clearProjectSettingsOverrides(custom, projectId, ["worktreeCleanup"]),
      },
    });
    expect(resolveWorktreeCleanup(reset, projectId)).toEqual(inherited);
  });
  it("completes partial machine custom rules and preserves them across edits", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeSettledAfterDays: 0, worktreeOnDelete: true },
    });
    const custom = applyServerSettingsPatch(initial, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: true } },
    });
    const edited = applyServerSettingsPatch(custom, {
      worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 15 } },
    });
    expect(resolveWorktreeCleanup(edited, null)).toEqual({
      worktreeAfterDays: 15,
      worktreeSettledAfterDays: 0,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(
      resolveWorktreeCleanup(applyServerSettingsPatch(edited, { worktreeCleanup: null }), null)
        .worktreeAfterDays,
    ).toBe(8);
  });
});

it("inherits branch naming defaults and applies project overrides independently", () => {
  const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    branchNamingMode: "static",
    branchNamePrefix: "team/",
    branchNameInstructions: "Use issue IDs.",
    projectSettingsOverrides: { [projectId]: { branchNamingMode: "custom" } },
  });
  expect(resolveProjectSettings(settings, projectId).settings).toMatchObject({
    branchNamingMode: "custom",
    branchNamePrefix: "team/",
    branchNameInstructions: "Use issue IDs.",
  });
  expect(resolveProjectSettings(settings, otherProjectId).settings).toMatchObject({
    branchNamingMode: "static",
    branchNamePrefix: "team/",
  });
  const cleared = applyServerSettingsPatch(settings, {
    projectSettingsOverrides: {
      [projectId]: clearProjectSettingsOverrides(settings, projectId, ["branchNamingMode"]),
    },
  });
  expect(resolveProjectSettings(cleared, projectId).settings.branchNamingMode).toBe("static");
});

describe("nativeHarnessModelSelection", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  // Only the fields the resolver reads; the server marks the harness's
  // configured model (here Claude Code's `sonnet`) as the default.
  const providers = [
    {
      instanceId: claude,
      models: [
        { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false },
        { slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false, isDefault: true },
        { slug: "my-proxy-model", name: "Proxy", isCustom: true, isDefault: true },
      ],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;

  it("keeps the saved harness but takes the harness's own model and options", () => {
    const saved = createModelSelection(claude, "claude-opus-5-5", [{ id: "effort", value: "low" }]);
    expect(nativeHarnessModelSelection(providers, saved)).toEqual({
      instanceId: claude,
      model: "claude-sonnet-5-5",
    });
  });

  it("keeps the saved selection while the harness's catalog is unknown", () => {
    const codex = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol");
    expect(nativeHarnessModelSelection(providers, codex)).toBe(codex);
    expect(nativeHarnessModelSelection([], null)).toBeNull();
  });
});

describe("in-app default harness", () => {
  const saved = ProviderInstanceId.make("codex");
  const selected = ProviderInstanceId.make("claudeAgent");
  const providers = [
    {
      instanceId: selected,
      enabled: true,
      installed: true,
      isHarnessDefault: true,
      models: [
        {
          slug: "sonnet",
          isDefault: true,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                currentValue: "max",
                options: [{ id: "max", isDefault: true }],
              },
            ],
          },
        },
      ],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
  it("prefers the app harness over the saved harness, including when there is no saved choice", () => {
    for (const fallback of [null, { instanceId: saved, model: "gpt" }]) {
      expect(nativeHarnessModelSelection(providers, fallback)).toEqual({
        instanceId: selected,
        model: "sonnet",
        options: [{ id: "effort", value: "max" }],
      });
    }
  });
  it("keeps the client's fallback when the chosen harness is disabled, missing or unavailable", () => {
    const fallback = { instanceId: saved, model: "gpt" };
    for (const changes of [
      { enabled: false },
      { installed: false },
      { availability: "unavailable" },
    ]) {
      expect(
        nativeHarnessModelSelection(
          providers.map((provider) => ({
            ...provider,
            ...changes,
          })) as ReadonlyArray<ServerProvider>,
          fallback,
        ),
      ).toBe(fallback);
    }
  });
});

describe("resolveNewChatModelSelection", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const options = (currentValue: string) => ({
    optionDescriptors: [
      {
        id: "effort",
        type: "select",
        currentValue,
        options: [{ id: "low" }, { id: "high" }, { id: "max" }],
      },
      {
        id: "speed",
        type: "select",
        currentValue: "normal",
        options: [{ id: "normal" }, { id: "fast" }],
      },
    ],
  });
  const providers = [
    {
      instanceId: codex,
      enabled: true,
      installed: true,
      models: [
        { slug: "native", isDefault: true, capabilities: options("high") },
        { slug: "sticky", capabilities: options("high") },
        { slug: "pinned", capabilities: options("max") },
      ],
    },
    {
      instanceId: claude,
      enabled: true,
      installed: true,
      models: [
        { slug: "sonnet", isDefault: true, capabilities: options("high") },
        { slug: "opus", capabilities: options("max") },
      ],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
  const history = {
    stickyActiveProvider: codex,
    stickyModelSelectionByProvider: {
      [codex]: { instanceId: codex, model: "sticky", options: [{ id: "effort", value: "low" }] },
      [claude]: { instanceId: claude, model: "opus" },
    },
    stickyOptionsByModelByProvider: {
      [codex]: { pinned: [{ id: "effort", value: "low" }] },
    },
  };
  const resolve = (input: Omit<Parameters<typeof resolveNewChatModelSelection>[0], "providers">) =>
    resolveNewChatModelSelection({ providers, ...input });

  it("uses the explicit harness and that harness's own last model", () => {
    expect(
      resolve({ ...history, harnessDefaults: { defaultHarness: claude, harnesses: {} } }),
    ).toEqual({
      instanceId: claude,
      model: "opus",
      options: [
        { id: "effort", value: "max" },
        { id: "speed", value: "normal" },
      ],
    });
  });

  it("applies an explicit model only within its harness without pinning the harness", () => {
    const harnessDefaults = { harnesses: { [codex]: { model: "pinned" } } };
    expect(resolve({ ...history, harnessDefaults })).toEqual({
      instanceId: codex,
      model: "pinned",
      options: [
        { id: "effort", value: "low" },
        { id: "speed", value: "normal" },
      ],
    });
    expect(resolve({ ...history, harnessDefaults, stickyActiveProvider: claude })?.model).toBe(
      "opus",
    );
  });

  it("uses sticky harness, model and options ahead of inherited defaults", () => {
    expect(
      resolve({ ...history, fallbackSelection: { instanceId: claude, model: "sonnet" } }),
    ).toEqual({
      instanceId: codex,
      model: "sticky",
      options: [
        { id: "effort", value: "low" },
        { id: "speed", value: "normal" },
      ],
    });
  });

  it("keeps native model and displayed options without history", () => {
    const fallbackSelection = { instanceId: codex, model: "pinned" };
    expect(resolve({ fallbackSelection })).toEqual(
      nativeHarnessModelSelection(providers, fallbackSelection),
    );
    expect(resolve({})).toBeNull();
    expect(
      resolve({
        ...history,
        harnessDefaults: { defaultHarness: claude, harnesses: {} },
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      instanceId: claude,
      model: "sonnet",
      options: [
        { id: "effort", value: "high" },
        { id: "speed", value: "normal" },
      ],
    });
  });

  it("overrides effort on the sticky model while retaining other remembered options", () => {
    expect(
      resolve({
        ...history,
        stickyOptionsByModelByProvider: {
          [codex]: {
            sticky: [
              { id: "effort", value: "low" },
              { id: "speed", value: "fast" },
            ],
          },
        },
        harnessDefaults: { harnesses: { [codex]: { options: { effort: "max" } } } },
      }),
    ).toEqual({
      instanceId: codex,
      model: "sticky",
      options: [
        { id: "effort", value: "max" },
        { id: "speed", value: "fast" },
      ],
    });
  });

  it("ignores unavailable explicit harnesses and invalid models or options", () => {
    expect(
      resolve({
        ...history,
        harnessDefaults: {
          defaultHarness: ProviderInstanceId.make("missing"),
          harnesses: { [codex]: { model: "missing", options: { effort: "invalid" } } },
        },
      })?.model,
    ).toBe("sticky");
    expect(
      resolveNewChatModelSelection({
        ...history,
        providers: providers.map((provider) =>
          provider.instanceId === claude ? { ...provider, enabled: false } : provider,
        ),
        harnessDefaults: { defaultHarness: claude, harnesses: {} },
      })?.instanceId,
    ).toBe(codex);
  });
});

describe("resolveNewChatModelSelection across the user's accounts", () => {
  const now = Date.parse("2026-11-17T08:00:00.000Z");
  const first = ProviderInstanceId.make("claudeAgent");
  const second = ProviderInstanceId.make("claudeAgent_work");
  const effort = {
    optionDescriptors: [
      {
        id: "effort",
        type: "select",
        currentValue: "high",
        options: [{ id: "high" }, { id: "max" }],
      },
    ],
  };
  const account = (instanceId: ProviderInstanceId, usedPercent: number) => ({
    instanceId,
    driver: "claudeAgent",
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: [
      { slug: "fable", name: "Fable", isDefault: true, capabilities: effort },
      { slug: "opus", name: "Opus", capabilities: effort },
    ],
    usageLimits: {
      checkedAt: "2026-11-17T08:00:00.000Z",
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: "2026-11-19T08:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
    },
  });
  const providers = [
    account(first, 90),
    account(second, 10),
  ] as unknown as ReadonlyArray<ServerProvider>;
  const history = {
    stickyActiveProvider: first,
    stickyModelSelectionByProvider: {
      [first]: { instanceId: first, model: "opus", options: [{ id: "effort", value: "max" }] },
    },
  };

  it("starts on the account with room and keeps the model and its options", () => {
    expect(
      resolveNewChatModelSelection({ providers, ...history, balanceAccounts: { now } }),
    ).toEqual({ instanceId: second, model: "opus", options: [{ id: "effort", value: "max" }] });
    // Balancing an already resolved selection keeps its options even with different device history.
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        stickyOptionsByModelByProvider: { [second]: { opus: [{ id: "effort", value: "high" }] } },
        balanceAccounts: { now },
      }),
    ).toEqual({ instanceId: second, model: "opus", options: [{ id: "effort", value: "max" }] });
  });

  it("resolves the requested effort before balancing sticky and configured defaults", () => {
    const highOnly = {
      ...providers[1]!,
      models: providers[1]!.models.map((entry) => ({
        ...entry,
        capabilities: {
          optionDescriptors: [
            {
              type: "select" as const,
              id: "effort",
              label: "Effort",
              currentValue: "high",
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      })),
    };
    const pool = [providers[0]!, highOnly];
    const expected = {
      instanceId: first,
      model: "opus",
      options: [{ id: "effort", value: "max" }],
    };
    expect(
      resolveNewChatModelSelection({ providers: pool, ...history, balanceAccounts: { now } }),
    ).toEqual(expected);
    expect(
      resolveNewChatModelSelection({
        providers: pool,
        harnessDefaults: {
          defaultHarness: first,
          harnesses: { [first]: { model: "opus", options: { effort: "max" } } },
        },
        balanceAccounts: { now },
      }),
    ).toEqual(expected);
  });
  it("keeps the remembered account when it has the room or balancing is off", () => {
    expect(resolveNewChatModelSelection({ providers, ...history })?.instanceId).toBe(first);
    expect(
      resolveNewChatModelSelection({ providers, ...history, balanceAccounts: null })?.instanceId,
    ).toBe(first);
    expect(
      resolveNewChatModelSelection({
        providers,
        stickyActiveProvider: second,
        stickyModelSelectionByProvider: { [second]: { instanceId: second, model: "opus" } },
        balanceAccounts: { now },
      })?.instanceId,
    ).toBe(second);
  });

  it("balances between the accounts of a harness set in settings", () => {
    // The setting names the harness; its accounts are that one harness.
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        harnessDefaults: { defaultHarness: first, harnesses: {} },
        balanceAccounts: { now },
      })?.instanceId,
    ).toBe(second);
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        harnessDefaults: { defaultHarness: first, harnesses: {} },
      })?.instanceId,
    ).toBe(first);
  });

  it("leaves out accounts the chat could not start the model on", () => {
    const third = ProviderInstanceId.make("claudeAgent_ultra3");
    const three = [...providers, account(third, 40)] as unknown as ReadonlyArray<ServerProvider>;
    const resolve = (accepts: (provider: ServerProvider, model: string) => boolean) =>
      resolveNewChatModelSelection({
        providers: three,
        ...history,
        balanceAccounts: { now, accepts },
      });
    // The roomiest account is off for this project: the next one takes the chat.
    expect(resolve((provider) => provider.instanceId !== second)?.instanceId).toBe(third);
    // The model is hidden on both others: the chat keeps its account and its model.
    expect(resolve((provider, model) => provider.instanceId === first || model !== "opus")).toEqual(
      { instanceId: first, model: "opus", options: [{ id: "effort", value: "max" }] },
    );
  });

  it("balances a device without history too", () => {
    expect(
      resolveNewChatModelSelection({
        providers,
        fallbackSelection: { instanceId: first, model: "fable" },
        balanceAccounts: { now },
      }),
    ).toMatchObject({ instanceId: second, model: "fable" });
  });
});

describe("resolveNewChatModelSelection following a remembered model", () => {
  const gateway = ProviderInstanceId.make("opencode");
  const plan = ProviderInstanceId.make("muse");
  const effort = {
    optionDescriptors: [
      {
        id: "effort",
        type: "select",
        currentValue: "high",
        options: [{ id: "high" }, { id: "max" }],
      },
    ],
  };
  const planProvider = {
    instanceId: plan,
    enabled: true,
    installed: true,
    models: [
      { slug: "muse-wonder-1.0", isDefault: true },
      { slug: "muse-ember-1.0", capabilities: effort },
    ],
  };
  const providers = [
    {
      instanceId: gateway,
      enabled: true,
      installed: true,
      models: [{ slug: "other", isDefault: true }, { slug: "openrouter/meta/muse-ember" }],
    },
    planProvider,
  ] as unknown as ReadonlyArray<ServerProvider>;
  const history = {
    stickyActiveProvider: gateway,
    stickyModelSelectionByProvider: {
      [gateway]: { instanceId: gateway, model: "openrouter/meta/muse-ember" },
    },
    stickyOptionsByModelByProvider: {
      [plan]: { "muse-ember-1.0": [{ id: "effort", value: "max" }] },
    },
  };
  const remembered = { instanceId: gateway, model: "openrouter/meta/muse-ember" };
  const toPlan = () => ({ instanceId: plan, model: "muse-ember-1.0" });

  it("starts on the better route it is given, with the options remembered for that route", () => {
    const asked: unknown[] = [];
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        rerouteSticky: (selection, all) => {
          asked.push([selection, all]);
          return toPlan();
        },
      }),
    ).toEqual({
      instanceId: plan,
      model: "muse-ember-1.0",
      options: [{ id: "effort", value: "max" }],
    });
    expect(asked).toEqual([[remembered, providers]]);
  });

  it("keeps the remembered route when none is better or the better one cannot run", () => {
    expect(
      resolveNewChatModelSelection({ providers, ...history, rerouteSticky: () => null }),
    ).toEqual(remembered);
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        rerouteSticky: () => ({ instanceId: plan, model: "missing" }),
      }),
    ).toEqual(remembered);
    expect(
      resolveNewChatModelSelection({
        providers: [
          providers[0]!,
          { ...planProvider, enabled: false },
        ] as unknown as ReadonlyArray<ServerProvider>,
        ...history,
        rerouteSticky: toPlan,
      }),
    ).toEqual(remembered);
  });

  it("never moves a harness or model chosen in settings", () => {
    let asked = 0;
    const rerouteSticky = () => {
      asked += 1;
      return toPlan();
    };
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        harnessDefaults: { defaultHarness: gateway, harnesses: {} },
        rerouteSticky,
      }),
    ).toEqual(remembered);
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        harnessDefaults: { harnesses: { [gateway]: { model: "other" } } },
        rerouteSticky,
      }),
    ).toEqual({ instanceId: gateway, model: "other" });
    expect(asked).toBe(0);
  });
});
