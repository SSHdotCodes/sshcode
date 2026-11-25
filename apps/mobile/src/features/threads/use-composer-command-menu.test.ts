import type { ModelOption } from "../../lib/modelOptions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

const refreshProviders = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {} },
}));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
  useThreadSearch: () => ({ matches: [], isPending: false }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftAttachments: vi.fn(),
  getComposerDraftSnapshot: vi.fn(),
  useComposerDraftSelection: () => null,
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { threadTranscript: Symbol("threadTranscript") },
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("./threadTranscriptAttachment", () => ({
  threadTranscriptComposerAttachment: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
// The on-demand rows of every subagent family: none here, so mentions use the shell's own.
vi.mock("../../state/entities", () => ({ useThreadPickerShells: () => [] }));
// Shared skills load through their own command; keep it out of the refresh counts.
vi.mock("../workflows/state", () => ({ workflowsState: () => null }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => refreshProviders,
}));

import {
  buildComposerModelItems,
  buildComposerSlashCommandItems,
  buildComposerWorkflowItems,
  rankComposerPathEntries,
  rankSlashMenuItems,
  resolveComposerCommandSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

describe("mobile file mention recency", () => {
  const exact = { path: "docs/plan" };
  const alpha = { path: "docs/alpha-plan.md" };
  const zulu = { path: "docs/zulu-plan.md" };
  const entries = [exact, alpha, zulu];

  it("leads with the most recently mentioned returned files on a bare @", () => {
    expect(rankComposerPathEntries(entries, "", [zulu.path, alpha.path])).toEqual([
      zulu,
      alpha,
      exact,
    ]);
  });

  it("boosts equally relevant files within the workspace result order", () => {
    expect(rankComposerPathEntries(entries, "plan", [zulu.path])).toEqual([exact, zulu, alpha]);
  });
});

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it("offers /workflow only with beta on in an existing chat", () => {
    const input = {
      query: "work",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: false,
      selectedProviderStatus: null,
    };
    expect(buildComposerSlashCommandItems(input)).toEqual([]);
    expect(buildComposerSlashCommandItems({ ...input, workflowsBeta: true })).toMatchObject([
      { command: "workflow", label: "/workflow" },
    ]);
    expect(
      buildComposerSlashCommandItems({ ...input, workflowsBeta: true, hasThread: false }),
    ).toEqual([]);
    expect(
      buildComposerSlashCommandItems({ ...input, workflowsBeta: true, atMessageStart: false }),
    ).toEqual([]);
  });

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("slash menu like the native apps", () => {
  const claude = {
    driver: ProviderDriverKind.make("claudeAgent"),
    slashCommands: [
      { name: "review", description: "Review a pull request" },
      { name: "btw", description: "Ask a quick side question" },
    ],
  };

  it("offers the side chat command only inside a thread", () => {
    const names = (hasThread: boolean) =>
      buildComposerSlashCommandItems({
        query: "",
        atMessageStart: true,
        hasThread,
        allowInteractionMode: false,
        selectedProviderStatus: claude,
      }).map((item) => item.label);

    expect(names(true)).toContain("/btw");
    expect(names(false)).not.toContain("/btw");
  });

  it("ranks name prefixes ahead of looser matches", () => {
    const item = (name: string, description: string) => ({
      id: `pcmd:${name}`,
      type: "provider-slash-command" as const,
      command: { name },
      label: `/${name}`,
      description,
    });
    const ranked = rankSlashMenuItems(
      [
        item("preview", "Open a preview"),
        item("diff", "Show the review diff"),
        item("re-run", "Run again"),
        item("review", "Review a pull request"),
      ],
      "re",
    );
    expect(ranked.map((entry) => entry.label)).toEqual(["/re-run", "/review", "/preview", "/diff"]);
  });

  it("inserts the skill token the server dispatches", () => {
    const skill = {
      name: "frontend-design",
      path: "/skills/frontend-design/SKILL.md",
      enabled: true,
    };
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/front",
        trigger: { rangeStart: 0, rangeEnd: 6 },
        item: {
          id: "skill:frontend-design",
          type: "skill",
          skill,
          label: "/frontend-design",
          description: "",
        },
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "$frontend-design ", cursor: 17, interactionMode: null });
  });

  it("inserts Claude's plain skill name", () => {
    expect(
      resolveComposerCommandSelection({
        draftMessage: "$demo",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item: {
          id: "skill:demo-skill",
          type: "skill",
          skill: {
            name: "demo-skill",
            path: "/Users/julius/.agents/skills/demo-skill/SKILL.md",
            enabled: true,
          },
          label: "/demo-skill",
          description: "",
        },
        allowInteractionMode: false,
      }).text,
    ).toBe("$demo-skill ");
  });
});

describe("workspace command discovery retry", () => {
  let root: Root;
  const environmentId = EnvironmentId.make("test-environment");
  const instanceId = ProviderInstanceId.make("claude");
  const provider = {
    instanceId,
    driver: ProviderDriverKind.make("claude"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    workspaceSnapshots: [
      {
        cwd: "/project-a",
        checkedAt: "2026-01-01T00:00:00.000Z",
        slashCommandsPending: true,
        slashCommands: [{ name: "compact" }],
        skills: [],
      },
    ],
  } satisfies ServerProvider;

  function Probe({
    cwd,
    status = provider,
    draft = "/project",
  }: {
    cwd: string;
    status?: ServerProvider;
    draft?: string;
  }) {
    const { onSelectionChange } = useComposerCommandMenu({
      sharedSkills: null,
      draftMessage: draft,
      ownerKey: null,
      environmentId,
      projectCwd: cwd,
      selectedProviderStatus: status,
      hasThread: false,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
    });
    useEffect(() => {
      onSelectionChange({ start: draft.length, end: draft.length });
    }, [draft, onSelectionChange]);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    refreshProviders.mockReset();
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for a command before discovering workspace completions", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", draft: "" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(0);
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", draft: "/project" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(1);
  });

  it("retries partial commands after the cooldown without editing the draft", async () => {
    const recovered = {
      ...provider,
      workspaceSnapshots: [{ ...provider.workspaceSnapshots[0], slashCommandsPending: false }],
    };
    refreshProviders.mockResolvedValueOnce({ _tag: "Success", value: { providers: [provider] } });
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(refreshProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, cwd: "/project-a" },
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it.each(["pi", "acpRegistry"])(
    "does not poll a healthy %s workspace without discovery",
    async (driver) => {
      const unsupported = {
        ...provider,
        driver: ProviderDriverKind.make(driver),
        workspaceSnapshots: [],
      };
      refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [unsupported] } });
      await act(async () => {
        root.render(createElement(Probe, { cwd: "/project-a", status: unsupported }));
      });
      expect(refreshProviders).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(refreshProviders).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("arms the remaining cooldown when a concurrent scan publishes partial commands", async () => {
    const missing = { ...provider, workspaceSnapshots: [] };
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockResolvedValueOnce({ _tag: "Success", value: { providers: [missing] } });
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: missing }));
    });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: provider }));
    });
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it("does not retry when a concurrent scan publishes a complete workspace", async () => {
    const missing = { ...provider, workspaceSnapshots: [] };
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [missing] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: missing }));
    });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a", status: recovered }));
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a rejected refresh while published discovery remains pending", async () => {
    const recovered = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommandsPending: false,
      })),
    };
    refreshProviders.mockRejectedValueOnce(new Error("Connection lost"));
    refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: [recovered] } });
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });

  it("cancels the old workspace retry and does not duplicate an in-flight request", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    refreshProviders.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-b" }));
    });
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(refreshProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, cwd: "/project-b" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry when the composer unmounts", async () => {
    await act(async () => {
      root.render(createElement(Probe, { cwd: "/project-a" }));
    });
    await act(async () => {
      root.unmount();
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("mobile model mentions", () => {
  const provider = (
    instanceId: string,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const option = (key: string, overrides: Partial<ModelOption> = {}): ModelOption => {
    const [instanceId = "", model = ""] = key.split(":");
    return {
      key,
      label: "GPT-6.1",
      subtitle: "",
      providerKey: instanceId,
      providerLabel: "Traex",
      providerDriver: "codex",
      isDefault: false,
      isLegacy: false,
      capabilities: null,
      selection: { instanceId: ProviderInstanceId.make(instanceId), model },
      ...overrides,
    };
  };

  it("replaces a model mention with prompt text and places the cursor after it", () => {
    const modelOption = option("codex:gpt-5.4");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "@gpt",
        trigger: { rangeStart: 0, rangeEnd: 4 },
        item: {
          id: `model:${modelOption.key}`,
          type: "model",
          option: modelOption,
          label: modelOption.label,
          description: modelOption.providerLabel,
        },
        allowInteractionMode: true,
      }),
    ).toEqual({
      text: "[GPT-6.1](t3-model://v1/codex/gpt-5.4) ",
      cursor: 39,
      interactionMode: null,
    });
  });

  it("offers current, visible models labelled with their provider", () => {
    const items = buildComposerModelItems(
      [
        option("traex:gpt-6.1"),
        option("opencode:traex/gpt-6.1", {
          subtitle: "Traex",
          providerLabel: "OpenCode",
          providerDriver: "opencode",
        }),
        option("hidden:gpt-6.1", { isHidden: true }),
        option("gone:gpt-6.1", { isUnavailable: true }),
        option("old:gpt-5", { label: "GPT-5", isLegacy: true }),
      ],
      "gpt",
      ["traex", "opencode", "hidden", "gone", "old"].map((id) => provider(id)),
    );
    expect(items.map((item) => [item.id, item.description]).sort()).toEqual([
      ["model:traex:gpt-6.1", "Traex"],
    ]);
  });

  it.each([
    ["missing", []],
    ["not installed", [provider("traex", { installed: false })]],
    ["signed out", [provider("traex", { auth: { status: "unauthenticated" } })]],
    ["not ready", [provider("traex", { status: "error" })]],
    ["unavailable", [provider("traex", { availability: "unavailable" })]],
  ] as const)("does not suggest a preserved selection whose provider is %s", (_, providers) => {
    expect(buildComposerModelItems([option("traex:gpt-6.1")], "gpt", providers)).toEqual([]);
  });
});

it.each([
  null,
  {
    driver: ProviderDriverKind.make("codex"),
    slashCommands: [{ name: "debug" }],
    showInteractionModeToggle: false,
  },
])(
  "offers one built-in debug command independently of provider capabilities",
  (selectedProviderStatus) => {
    const input = {
      query: "debug",
      atMessageStart: true,
      hasThread: false,
      allowInteractionMode: false,
      selectedProviderStatus,
    };
    const items = buildComposerSlashCommandItems(input);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "slash-command", command: "debug" });
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/deb",
        trigger: { rangeStart: 0, rangeEnd: 4 },
        item: items[0]!,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/debug ", cursor: 7, interactionMode: null });
    expect(buildComposerSlashCommandItems({ ...input, atMessageStart: false })).toEqual([]);
  },
);

describe("buildComposerWorkflowItems", () => {
  const workflow = (id: string, name: string, updatedAt: string) =>
    ({
      version: 1,
      id,
      name,
      description: "",
      rootNodeId: null,
      nodes: [
        { kind: "agent", id: "a" },
        { kind: "agent", id: "b" },
        { kind: "note", id: "n" },
      ],
      edges: [],
      createdAt: updatedAt,
      updatedAt,
    }) as never;

  it("matches every typed word, newest first, and counts agents", () => {
    const items = buildComposerWorkflowItems(
      [
        workflow("wf_old", "Opus team", "2026-11-05T00:00:00.000Z"),
        workflow("wf_new", "Opus review team", "2026-11-06T00:00:00.000Z"),
        workflow("wf_other", "Release", "2026-11-06T00:00:00.000Z"),
      ],
      "opus team",
    );
    expect(items.map((item) => item.label)).toEqual(["Opus review team", "Opus team"]);
    expect(items[0]).toMatchObject({ type: "workflow", description: "Workflow · 2 agents" });
  });

  it("offers nothing until something is typed", () => {
    expect(
      buildComposerWorkflowItems([workflow("wf", "Opus", "2026-11-06T00:00:00.000Z")], " "),
    ).toEqual([]);
  });
});

describe("large slash menu", () => {
  it("keeps commands past the first render window searchable and selectable", () => {
    const commands = Array.from({ length: 1_000 }, (_, index) => ({
      name: `command-${index}`,
      description: `Run command ${index}`,
    }));
    const build = (query: string) =>
      rankSlashMenuItems(
        buildComposerSlashCommandItems({
          query,
          atMessageStart: true,
          hasThread: true,
          allowInteractionMode: true,
          selectedProviderStatus: {
            driver: ProviderDriverKind.make("codex"),
            slashCommands: commands,
          },
        }),
        query,
      );
    const items = build("");
    expect(items).toHaveLength(1004);
    const match = build("command-999");
    expect(match).toHaveLength(1);
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/command-999",
        trigger: { rangeStart: 0, rangeEnd: 12 },
        item: match[0]!,
        allowInteractionMode: true,
      }).text,
    ).toBe("/command-999 ");
    const makeRow = (item: (typeof items)[number]) =>
      createElement("row", { key: item.id, item, onPress: () => item.id });
    const start = performance.now();
    for (let i = 0; i < 50; i++) items.map(makeRow);
    const before = (performance.now() - start) / 50;
    const middle = performance.now();
    for (let i = 0; i < 50; i++) items.slice(0, 8).map(makeRow);
    console.info(
      "slash menu:1004 initial row elements before/after (ms)",
      before,
      (performance.now() - middle) / 50,
    );
  });
});

it("keeps the phone picker's model order, putting saved favorites first and limiting the group", () => {
  const models: ModelOption[] = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map(
    (word) => ({
      key: `muse:ember-${word}`,
      label: `Muse Ember ${word}`,
      subtitle: "",
      providerKey: "muse",
      providerLabel: "Muse Account",
      providerDriver: "muse",
      isDefault: false,
      isLegacy: false,
      capabilities: null,
      selection: { instanceId: ProviderInstanceId.make("muse"), model: `ember-${word}` },
    }),
  );
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("muse"),
    driver: ProviderDriverKind.make("muse"),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((model) => ({
      slug: model.selection.model,
      name: model.label,
      isCustom: false,
      capabilities: {},
    })),
    skills: [],
    slashCommands: [],
  };
  for (const query of ["mu", "ember", "muse"]) {
    expect(
      buildComposerModelItems(models, query, [provider], {
        favorites: [{ instanceId: "muse", slug: "ember-zeta" }],
      }).map((item) => item.label),
    ).toEqual(["Muse Ember zeta", "Muse Ember alpha", "Muse Ember beta", "Muse Ember gamma"]);
  }
  expect(buildComposerModelItems(models, "", [provider])).toEqual([]);
  expect(buildComposerModelItems(models, "src", [provider])).toEqual([]);
});

import { resolveComposerMenuSelection } from "./use-composer-command-menu";
it("uses only the active draft's selection and clamps its own old caret", () => {
  const local = { ownerKey: "a", start: 20, end: 20 };
  expect(
    resolveComposerMenuSelection({ draftMessage: "hello", ownerKey: "b", inserted: null, local }),
  ).toEqual({ start: 5, end: 5 });
  expect(
    resolveComposerMenuSelection({ draftMessage: "hello", ownerKey: "a", inserted: null, local }),
  ).toEqual({ start: 5, end: 5 });
  expect(
    resolveComposerMenuSelection({
      draftMessage: "hello",
      ownerKey: "b",
      inserted: { start: 2, end: 2 },
      local,
    }),
  ).toEqual({ start: 2, end: 2 });
});

it("ranks slash commands and skills by recent use on empty query and equal-rank ties", () => {
  const items = [
    {
      id: "cmd:debug",
      type: "slash-command" as const,
      command: "debug" as const,
      label: "/debug",
      description: "Debug",
    },
    {
      id: "cmd:model",
      type: "slash-command" as const,
      command: "model" as const,
      label: "/model",
      description: "Switch model",
    },
    {
      id: "pcmd:compact",
      type: "provider-slash-command" as const,
      command: { name: "compact" },
      label: "/compact",
      description: "Compact",
    },
    {
      id: "skill:compose",
      type: "skill" as const,
      skill: { name: "compose", path: "/skills/compose/SKILL.md", enabled: true },
      label: "/compose",
      description: "Compose",
    },
  ];
  expect(
    rankSlashMenuItems(items, "", ["skill:compose", "slash:model"]).map((item) => item.id),
  ).toEqual(["skill:compose", "cmd:model", "cmd:debug", "pcmd:compact"]);
  // Equal prefix rank ("comp") breaks ties by recent use.
  expect(
    rankSlashMenuItems(items.slice(2), "comp", ["skill:compose"]).map((item) => item.id),
  ).toEqual(["skill:compose", "pcmd:compact"]);
});
