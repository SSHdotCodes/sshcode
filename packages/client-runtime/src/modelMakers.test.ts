import { describe, expect, it } from "vite-plus/test";

import {
  canonicalModelId,
  defaultModelRoute,
  findMakerModel,
  groupModelsByMaker,
  modelRouteLabel,
  modelVendorFamily,
  OTHER_MAKER_ID,
  makerUsesOf,
  orderMakerModelsByUse,
  orderMakersByUse,
  ownHarnessRouteForRememberedModel,
  parseModelRouteMemory,
  rememberChosenModelRoute,
  stickyModelRerouter,
  type MakerModel,
  type ModelRouteSource,
} from "./modelMakers.ts";

const instances = {
  claudeAgent: { driver: "claudeAgent", instanceName: "Claude" },
  codex: { driver: "codex", instanceName: "Codex" },
  claudeAgent_qwen4: { driver: "claudeAgent", instanceName: "Qwen4 · Claude Code" },
  acpRegistry_qwen_code: { driver: "acpRegistry", instanceName: "Qwen4 · Qwen Code" },
  acpRegistry_kimi: { driver: "acpRegistry", instanceName: "Kimi Code" },
  acpRegistry_kimi_api: { driver: "acpRegistry", instanceName: "Kimi (API key)" },
  acpRegistry_kimi_open: { driver: "acpRegistry", instanceName: "Kimi Code · OpenRouter" },
  acpRegistry_hermes_open: { driver: "acpRegistry", instanceName: "Hermes · Open models" },
  acpRegistry_mistral_vibe: { driver: "acpRegistry", instanceName: "Mistral Vibe" },
  pi_open_models: { driver: "pi", instanceName: "Pi · Open models" },
  opencode: { driver: "opencode", instanceName: "OpenCode" },
  home_pi: { driver: "pi", instanceName: "Home · Pi" },
  home_hermes: { driver: "acpRegistry", instanceName: "Home · Hermes" },
  home_opencode: { driver: "opencode", instanceName: "Home · OpenCode" },
  home_deepseek: { driver: "acpRegistry", instanceName: "Home · DeepSeek" },
  home_claude: { driver: "claudeAgent", instanceName: "Home · Claude Code" },
  muse: { driver: "muse", instanceName: "Muse Code" },
  antigravity: { driver: "antigravity", instanceName: "Antigravity" },
  acpRegistry_devin: { driver: "acpRegistry", instanceName: "Devin" },
} as const;

type Instance = keyof typeof instances;

function source(
  instanceId: Instance,
  slug: string,
  name = slug,
  extra: Partial<ModelRouteSource> = {},
): ModelRouteSource {
  return { instanceId, ...instances[instanceId], slug, name, ...extra };
}

/** Shaped like the owner's live catalog, Nov 2026. */
const catalog: ReadonlyArray<ModelRouteSource> = [
  source("codex", "gpt-6.1-sol", "GPT-6.1-Sol"),
  source("codex", "gpt-6-sol", "GPT-6-Sol", { isLegacy: true }),
  source("claudeAgent", "claude-opus-5-5", "Claude Opus 5.5"),
  source("claudeAgent", "claude-fable-5-1", "Claude Fable 5.1"),
  source("claudeAgent_qwen4", "qwen-latest-series-invite-1102", "Qwen4 (early access)"),
  source("acpRegistry_qwen_code", "qwen-latest-series-invite-1102(openai)", "Qwen4 (early access)"),
  source("acpRegistry_kimi", "default", "Default"),
  source("acpRegistry_kimi", "kimi-code/k3.1-pro", "K3.1 Pro"),
  source("acpRegistry_kimi", "kimi-code/k3.1-pro-highspeed", "K3.1 Pro Highspeed"),
  source("acpRegistry_kimi_api", "opus", "k3.1-pro"),
  source("acpRegistry_kimi_api", "sonnet", "k3.1-pro"),
  source("acpRegistry_kimi_open", "flint", "recursive/flint-v1.0:free"),
  source("acpRegistry_kimi_open", "glm", "z-ai/glm-5.3-flash"),
  source("acpRegistry_hermes_open", "anthropic:claude-opus-5-5", "Anthropic · claude-opus-5-5"),
  source("acpRegistry_hermes_open", "anthropic:claude-fable-5.1", "Anthropic · claude-fable-5.1"),
  source(
    "acpRegistry_hermes_open",
    "custom:openrouter:deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4.1-flash",
  ),
  source("acpRegistry_hermes_open", "custom:openrouter:z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"),
  source("acpRegistry_hermes_open", "custom:opencode-go:glm-5.3-flash", "glm-5.3-flash"),
  source("acpRegistry_hermes_open", "custom:openrouter:recursive/flint-v1.0:free", "Flint"),
  source("acpRegistry_mistral_vibe", "mistral-large-4", "Mistral Large 4"),
  source("acpRegistry_mistral_vibe", "zai-glm-5-3-flash", "GLM-5.3 Flash (Mistral Hosted)"),
  source("acpRegistry_mistral_vibe", "deepseek-v4-1-flash", "DeepSeek V4.1 Flash (Mistral Hosted)"),
  source("pi_open_models", "openrouter/z-ai/glm-5.3-flash", "GLM-5.3 Flash"),
  source("pi_open_models", "opencode-go/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
  source("opencode", "openrouter/z-ai/glm-5.3-flash", "GLM 5.3 Flash", {
    subProvider: "OpenRouter",
  }),
  source("home_pi", "home-glm-5.3-flash/glm-5.3-flash", "GLM-5.3 Flash"),
  source("home_hermes", "deepseek-v4.1-flash-1017", "DeepSeek V4.1 Flash 1017"),
  source(
    "home_opencode",
    "blackwell-glm/glm-5.3-flash",
    "GLM-5.3 Flash (high reasoning · default)",
    { subProvider: "blackwell-glm" },
  ),
  source("home_opencode", "blackwell-glm/glm-5.3-flash-max", "GLM-5.3 Flash (max reasoning)", {
    subProvider: "blackwell-glm",
  }),
  source("home_opencode", "blackwell-glm/glm-5.3-flash-title", "GLM 5.3 Flash — title helper", {
    subProvider: "blackwell-glm",
  }),
  source(
    "home_opencode",
    "blackwell-ds41/deepseek-v4.1-flash-1017",
    "DeepSeek V4.1 Flash 1017 (high reasoning · default)",
    { subProvider: "blackwell-ds41" },
  ),
  source(
    "home_opencode",
    "blackwell-ds41/deepseek-v4.1-flash-1017-k3",
    "DeepSeek V4.1 Flash 1017 3-bit (faster)",
    { subProvider: "blackwell-ds41" },
  ),
  source("home_deepseek", "default", "Default"),
  source("home_deepseek", '["home","deepseek-v4.1-flash-1017"]', "DeepSeek V4.1 Flash 1017"),
  source("home_claude", "nanbeige4.3-33b", "nanbeige4.3-33b"),
];

const groups = groupModelsByMaker(catalog);
const model = (makerId: string, name: string): MakerModel<ModelRouteSource> => {
  const found = groups
    .find((group) => group.maker.id === makerId)
    ?.models.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No ${name} under ${makerId}`);
  return found;
};
const labels = (entry: MakerModel<ModelRouteSource>) => entry.routes.map((route) => route.label);

describe("groupModelsByMaker", () => {
  it("shows one icon per maker, in a fixed order with Other last", () => {
    expect(groups.map((group) => group.maker.label)).toEqual([
      "OpenAI",
      "Anthropic",
      "Qwen",
      "Kimi",
      "Z.ai",
      "DeepSeek",
      "Mistral",
      "Flint",
      "Other",
    ]);
  });

  it("names two accounts of one harness as plans: Max beside Max-2", () => {
    const second = (name: string): ModelRouteSource => ({
      instanceId: "claudeAgent_work",
      driver: "claudeAgent",
      instanceName: name,
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
    });
    const routesOf = (sources: ReadonlyArray<ModelRouteSource>) =>
      groupModelsByMaker(sources)
        .flatMap((group) => group.models)
        .find((entry) => entry.name === "Claude Opus 5.5")
        ?.routes.map((route) => route.label);
    const own = source("claudeAgent", "claude-opus-5-5", "Claude Opus 5.5");
    expect(routesOf([own, second("Max-2")])).toEqual(["Max", "Max-2"]);
    // A name without a number says nothing about the own account.
    expect(routesOf([own, second("Work")])).toEqual(["Claude Code", "Work"]);
    // Alone, and beside another harness, the own account keeps its harness name.
    expect(routesOf([own])).toEqual(["Claude Code"]);
    expect(labels(model("anthropic", "Claude Opus 5.5"))).toEqual([
      "Claude Code",
      "Hermes · Anthropic",
    ]);
  });

  it("merges one model reached through several harnesses and gateways", () => {
    // Best first: GLM's harness ranking (Pi, Kimi Code, Hermes), then the rest.
    expect(labels(model("zai", "GLM-5.3 Flash"))).toEqual([
      "Pi · OpenRouter",
      "Home · Pi",
      "Kimi Code · OpenRouter",
      "Hermes · OpenRouter",
      "Hermes · OpenCode Go",
      "Mistral Vibe",
      "OpenCode · OpenRouter",
      "Home · blackwell-glm",
    ]);
    expect(labels(model("qwen", "Qwen4"))).toEqual(["Qwen Code", "Claude Code"]);
    expect(labels(model("anthropic", "Claude Opus 5.5"))).toEqual([
      "Claude Code",
      "Hermes · Anthropic",
    ]);
  });

  it("names a merged model by the model, never its gateway", () => {
    const groups = groupModelsByMaker([
      source("home_pi", "home-glm-5.3-flash/glm-5.3-flash", "glm-5.3-flash"),
      source("pi_open_models", "openrouter-open/z-ai/glm-5.3-flash", "GLM-5.3-Flash · OpenRouter"),
      source("acpRegistry_kimi_open", "openrouter/glm-5.3-flash", "GLM-5.3-Flash · OpenRouter"),
      source(
        "acpRegistry_hermes_open",
        "custom:openrouter:z-ai/glm-5.3-flash",
        "z-ai/glm-5.3-flash",
      ),
    ]);
    expect(groups.flatMap((group) => group.models.map((entry) => entry.name))).toEqual([
      "GLM-5.3-Flash",
    ]);
    expect(
      groupModelsByMaker([
        source("pi_open_models", "openrouter-open/x/y", "OpenRouter · Nova 2"),
      ]).flatMap((group) => group.models.map((entry) => entry.name)),
    ).toEqual(["Nova 2"]);
  });

  it("names Antigravity's orchestrators by the model that runs them", () => {
    const names = groupModelsByMaker([
      source("antigravity", "gemini-pro-orchestrator-neon", "Orchestrator (Neon)"),
      source("antigravity", "gemini-pro-orchestrator", "Orchestrator (Carbon)"),
    ]).flatMap((group) => group.models.map((entry) => entry.name));
    expect(names.toSorted()).toEqual(["Carbon Orchestrator", "Neon Orchestrator"]);
  });

  it("files a model by its maker, not the harness serving it", () => {
    expect(labels(model("recursive", "Flint"))).toEqual([
      "Kimi Code · OpenRouter",
      "Hermes · OpenRouter",
    ]);
    expect(
      model("zai", "GLM-5.3 Flash").routes.some(
        (route) => route.source.instanceId === "acpRegistry_kimi_open",
      ),
    ).toBe(true);
    // Claude Code on another endpoint runs a model Anthropic didn't make.
    expect(labels(model("other", "nanbeige4.3-33b"))).toEqual(["Home · Claude Code"]);
  });

  it("keeps checkpoints apart and folds effort variants into their model", () => {
    const deepseek = groups.find((group) => group.maker.id === "deepseek")!;
    expect(deepseek.models.map((entry) => entry.name)).toEqual([
      "DeepSeek V4.1 Flash",
      "DeepSeek V4.1 Flash 1017",
      "DeepSeek V4.1 Flash 1017 3-bit",
      "Home · DeepSeek default",
    ]);
    expect(labels(model("deepseek", "DeepSeek V4.1 Flash 1017"))).toEqual([
      "Home · Hermes",
      "Home · blackwell-ds41",
      "Home",
    ]);
    expect(labels(model("deepseek", "DeepSeek V4.1 Flash"))).toEqual([
      "Hermes · OpenRouter",
      "Pi · OpenCode Go",
      "Mistral Vibe",
    ]);
    const homeGlm = model("zai", "GLM-5.3 Flash").routes.find(
      (route) => route.source.instanceId === "home_opencode",
    )!;
    expect(homeGlm.source.slug).toBe("blackwell-glm/glm-5.3-flash");
    expect(homeGlm.sources.map((entry) => entry.slug)).toEqual([
      "blackwell-glm/glm-5.3-flash",
      "blackwell-glm/glm-5.3-flash-max",
      "blackwell-glm/glm-5.3-flash-title",
    ]);
  });

  it("joins a harness's version-less aliases to the model their name gives", () => {
    const k31 = model("moonshot", "K3.1 Pro");
    expect(labels(k31)).toEqual(["Kimi Code", "Kimi (API key)"]);
    expect(model("moonshot", "K3.1 Pro Highspeed").routes).toHaveLength(1);
    // The harness's own default stays one row per harness.
    expect(model("moonshot", "Kimi Code default").routes).toHaveLength(1);
  });

  it("orders a maker's models by its own harness and puts legacy last", () => {
    expect(groups[0]!.models.map((entry) => [entry.name, entry.isLegacy])).toEqual([
      ["GPT-6.1-Sol", false],
      ["GPT-6-Sol", true],
    ]);
  });
});

describe("Muse models with a Muse Code plan", () => {
  // OpenCode lists first in the catalog, as it does live.
  const muse = groupModelsByMaker([
    source("opencode", "opencode/muse-spark-1.3", "Muse Spark 1.3"),
    source("opencode", "opencode/muse-wonder-1.0", "Muse Wonder"),
    source("muse", "muse-wonder-1.0", "Muse Wonder 1.0"),
    source("muse", "muse-wonder-full-1.0", "Muse Wonder Full 1.0"),
    source("muse", "muse-ember-1.0", "Muse Ember 1.0"),
    source("muse", "muse-spark-1.3", "Muse Spark 1.3"),
  ]).find((group) => group.maker.id === "muse")!;

  it("lists them in Muse Code's order and opens each on Muse Code", () => {
    expect(
      muse.models.map((entry) => [entry.name, defaultModelRoute(entry)?.source.instanceId]),
    ).toEqual([
      ["Muse Wonder", "muse"],
      ["Muse Wonder Full 1.0", "muse"],
      ["Muse Ember 1.0", "muse"],
      ["Muse Spark 1.3", "muse"],
    ]);
  });

  it("remembers only a route chosen over the default", () => {
    const ember = muse.models.find((entry) => entry.name === "Muse Ember 1.0")!;
    const wonder = muse.models[0]!;
    const viaOpenCode = { instanceId: "opencode", slug: "opencode/muse-wonder-1.0" };
    const viaMuse = { instanceId: "muse", slug: "muse-wonder-1.0" };
    // Picking the default leaves nothing behind, and clears an older entry.
    expect(rememberChosenModelRoute({}, wonder, viaMuse)).toEqual({});
    expect(rememberChosenModelRoute({ [wonder.key]: viaOpenCode }, wonder, viaMuse)).toEqual({});
    // A route chosen over the default sticks, with the default it was chosen over.
    expect(rememberChosenModelRoute({}, wonder, viaOpenCode)).toEqual({
      [wonder.key]: { ...viaOpenCode, over: viaMuse },
    });
    // While Muse Code can't run, OpenCode is the default, so picking it is not a preference:
    // the model goes back to Muse Code once that can run again.
    const museDown = (route: { readonly source: { readonly driver: string } }) =>
      route.source.driver !== "muse";
    expect(rememberChosenModelRoute({}, wonder, viaOpenCode, museDown)).toEqual({});
    expect(ember.routes).toHaveLength(1);
  });

  it("holds a pick only while the default it was made over stands", () => {
    const wonder = muse.models[0]!;
    const viaOpenCode = { instanceId: "opencode", slug: "opencode/muse-wonder-1.0" };
    const viaMuse = { instanceId: "muse", slug: "muse-wonder-1.0" };
    const opensOn = (lastUsed: Parameters<typeof defaultModelRoute>[1]) =>
      defaultModelRoute(wonder, lastUsed)?.source.instanceId;
    // Picked over Muse Code, which is still the default: the pick stands.
    expect(opensOn({ lastUsed: { ...viaOpenCode, over: viaMuse } })).toBe("opencode");
    // Picked when something else was the default: Muse Code was not on offer then.
    expect(
      opensOn({
        lastUsed: { ...viaOpenCode, over: { instanceId: "opencode", slug: "meta/muse-wonder" } },
      }),
    ).toBe("muse");
    // A pick saved before picks recorded their default loses to the maker's own harness.
    expect(opensOn({ lastUsed: viaOpenCode })).toBe("muse");
    // While Muse Code can't run the model opens elsewhere, and returns when it can.
    expect(
      defaultModelRoute(wonder, {
        lastUsed: { ...viaOpenCode, over: viaMuse },
        isAvailable: (route) => route.source.driver !== "muse",
      })?.source.instanceId,
    ).toBe("opencode");
  });

  it("reads saved picks with or without the default they were made over", () => {
    expect(
      parseModelRouteMemory(
        JSON.stringify({
          a: { instanceId: "opencode", slug: "x", over: { instanceId: "muse", slug: "y" } },
          b: { instanceId: "opencode", slug: "x", over: "muse" },
          c: { instanceId: "opencode" },
        }),
      ),
    ).toEqual({
      a: { instanceId: "opencode", slug: "x", over: { instanceId: "muse", slug: "y" } },
      b: { instanceId: "opencode", slug: "x" },
    });
  });

  it("falls back to another route while Muse Code can't run", () => {
    const wonder = muse.models[0]!;
    expect(
      defaultModelRoute(wonder, { isAvailable: (route) => route.source.driver !== "muse" })?.source
        .instanceId,
    ).toBe("opencode");
  });
});

describe("defaultModelRoute", () => {
  const glm = model("zai", "GLM-5.3 Flash");

  it("prefers the route last used for the model", () => {
    expect(
      defaultModelRoute(glm, {
        lastUsed: { instanceId: "acpRegistry_mistral_vibe", slug: "zai-glm-5-3-flash" },
      })?.label,
    ).toBe("Mistral Vibe");
    // An effort variant of the route still counts as that route.
    expect(
      defaultModelRoute(glm, {
        lastUsed: { instanceId: "home_opencode", slug: "blackwell-glm/glm-5.3-flash-max" },
      })?.label,
    ).toBe("Home · blackwell-glm");
  });

  it("follows the family's harness ranking", () => {
    expect(defaultModelRoute(glm)?.label).toBe("Pi · OpenRouter");
    expect(defaultModelRoute(model("deepseek", "DeepSeek V4.1 Flash"))?.label).toBe(
      "Hermes · OpenRouter",
    );
    expect(defaultModelRoute(model("recursive", "Flint"))?.label).toBe("Kimi Code · OpenRouter");
    expect(defaultModelRoute(model("qwen", "Qwen4"))?.label).toBe("Qwen Code");
    expect(defaultModelRoute(model("anthropic", "Claude Opus 5.5"))?.label).toBe("Claude Code");
  });

  it("skips routes that can't run while another can", () => {
    expect(
      defaultModelRoute(model("qwen", "Qwen4"), {
        isAvailable: (route) => route.label !== "Qwen Code",
      })?.label,
    ).toBe("Claude Code");
    expect(
      defaultModelRoute(model("qwen", "Qwen4"), {
        lastUsed: { instanceId: "acpRegistry_qwen_code", slug: "x" },
        isAvailable: () => false,
      })?.label,
    ).toBe("Qwen Code");
  });
});

describe("findMakerModel", () => {
  it("finds the model a selection runs, by any of its slugs", () => {
    expect(
      findMakerModel(groups, {
        instanceId: "home_opencode",
        slug: "blackwell-glm/glm-5.3-flash-max",
      })?.name,
    ).toBe("GLM-5.3 Flash");
    expect(findMakerModel(groups, { instanceId: "codex", slug: "gpt-9" })).toBeNull();
  });
});

describe("pieces", () => {
  it("normalizes ids across gateways", () => {
    const id = (slug: string, name = slug) => {
      const entry = source("opencode", slug, name);
      return canonicalModelId(entry, modelVendorFamily(entry));
    };
    expect(id("z-ai/glm-5.3-flash")).toBe("glm-5-3-flash");
    expect(id("zai-glm-5-3-flash")).toBe("glm-5-3-flash");
    expect(id("custom:openrouter:recursive/flint-v1.0:free")).toBe("flint-v1-0");
    expect(id('["home","deepseek-v4.1-flash-1017-k3"]')).toBe("deepseek-v4-1-flash-1017-k3");
  });

  it("names a route by harness and gateway", () => {
    expect(
      modelRouteLabel(source("pi_open_models", "opencode-go/glm-5.3-flash"), "GLM-5.3 Flash"),
    ).toBe("Pi · OpenCode Go");
    expect(
      modelRouteLabel(
        source("opencode", "opencode/glm-5.3-flash", "GLM", { subProvider: "OpenCode Zen" }),
        "GLM",
      ),
    ).toBe("OpenCode Zen");
  });
});

describe("the Meta group", () => {
  const meta = groupModelsByMaker([
    source("opencode", "openrouter/meta-llama/llama-4-scout", "Llama 4 Scout"),
    source("opencode", "openrouter/meta/muse-ember", "Muse Ember"),
    source("opencode", "openrouter/meta/muse-spark", "Muse Spark"),
    source("opencode", "meta/muse-ember-1.0", "Muse Ember"),
    source("opencode", "meta/muse-spark-1.2", "Muse Spark 1.2"),
    source("opencode", "meta/muse-spark-1.3", "Muse Spark 1.3"),
    source("muse", "muse-ember-1.0", "Muse Ember 1.0"),
    source("muse", "muse-spark-1.3", "Muse Spark 1.3"),
  ]);

  it("holds Muse and Llama under Meta, the plan's models first and Llama last", () => {
    expect(meta.map((group) => [group.maker.id, group.maker.label])).toEqual([["muse", "Meta"]]);
    expect(
      meta[0]!.models.map((entry) => [entry.name, defaultModelRoute(entry)?.source.instanceId]),
    ).toEqual([
      ["Muse Ember", "muse"],
      ["Muse Spark 1.3", "muse"],
      ["Muse Spark", "opencode"],
      ["Muse Spark 1.2", "opencode"],
      ["Llama 4 Scout", "opencode"],
    ]);
  });

  it("folds a gateway's unversioned alias into the line's only release", () => {
    const ember = meta[0]!.models[0]!;
    expect(ember.routes.map((route) => route.source.slug)).toEqual([
      "muse-ember-1.0",
      "meta/muse-ember-1.0",
      "openrouter/meta/muse-ember",
    ]);
    // Spark has two releases listed, so its alias names neither and stays a row.
    expect(meta[0]!.models.filter((entry) => entry.name.startsWith("Muse Spark"))).toHaveLength(3);
  });
});

describe("orderMakersByUse", () => {
  const now = Date.parse("2026-11-13T07:00:00.000Z");
  const daysAgo = (days: number) => now - days * 86_400_000;
  const maker = (id: string) => ({ id, label: id, icon: null, monogram: id[0]! });
  const makers = [maker("openai"), maker("anthropic"), maker("xai"), maker("google")];
  const sources = [
    {
      instanceId: "codex",
      driver: "codex",
      instanceName: "Codex",
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
    },
  ];

  it("puts the makers of the chats you start first, recent ones counting more", () => {
    const ordered = orderMakersByUse(
      makers,
      [
        { instanceId: "claudeAgent", slug: "claude-opus-5-5", at: daysAgo(1) },
        { instanceId: "claudeAgent", slug: "claude-fable-5-2", at: daysAgo(2) },
        { instanceId: "codex", slug: "gpt-6.1-sol", at: daysAgo(1) },
        // Three old Grok chats weigh less than two recent Claude ones.
        { instanceId: "grok", slug: "grok-5", at: daysAgo(60) },
        { instanceId: "grok", slug: "grok-5", at: daysAgo(61) },
        { instanceId: "grok", slug: "grok-5", at: daysAgo(62) },
      ],
      sources,
      now,
    );
    expect(ordered.map((entry) => entry.id)).toEqual(["anthropic", "openai", "xai", "google"]);
  });

  it("keeps the fixed order without use, and ignores chats past the window", () => {
    const ordered = orderMakersByUse(
      makers,
      [{ instanceId: "gemini", slug: "gemini-4-carbon", at: daysAgo(400) }],
      sources,
      now,
    );
    expect(ordered.map((entry) => entry.id)).toEqual(["openai", "anthropic", "xai", "google"]);
  });

  it("keeps Other last however often its models are used", () => {
    const ordered = orderMakersByUse(
      [maker("other"), ...makers],
      [
        { instanceId: "home_opencode", slug: "nib-4b", at: daysAgo(1) },
        { instanceId: "home_opencode", slug: "pointer-a50", at: daysAgo(1) },
        { instanceId: "codex", slug: "gpt-6.1-sol", at: daysAgo(2) },
      ],
      sources,
      now,
    );
    expect(ordered.map((entry) => entry.id)).toEqual([
      "openai",
      "anthropic",
      "xai",
      "google",
      "other",
    ]);
  });
});

describe("orderMakerModelsByUse", () => {
  const now = Date.parse("2026-11-13T07:00:00.000Z");
  const daysAgo = (days: number) => now - days * 86_400_000;

  it("orders a maker's models by recent chat starts while keeping legacy models last", () => {
    const allSources = [
      source("claudeAgent", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
      source("claudeAgent", "claude-haiku-5-5", "Claude Haiku 5.5"),
      source("claudeAgent", "claude-opus-5-5", "Claude Opus 5.5"),
      source("claudeAgent", "claude-opus-4-8", "Claude Opus 4.8", { isLegacy: true }),
    ];
    const groups = groupModelsByMaker(allSources);
    const ordered = orderMakerModelsByUse(
      groups,
      [
        { instanceId: "claudeAgent", slug: "claude-opus-5-5", at: daysAgo(1) },
        { instanceId: "claudeAgent", slug: "claude-opus-5-5", at: daysAgo(2) },
        // A legacy model started frequently still stays after current non-legacy models.
        { instanceId: "claudeAgent", slug: "claude-opus-4-8", at: daysAgo(1) },
        { instanceId: "claudeAgent", slug: "claude-opus-4-8", at: daysAgo(1) },
        { instanceId: "claudeAgent", slug: "claude-opus-4-8", at: daysAgo(1) },
        { instanceId: "claudeAgent", slug: "claude-haiku-5-5", at: daysAgo(1) },
      ],
      allSources,
      now,
    );
    expect(ordered[0]!.models.map((entry) => entry.name)).toEqual([
      "Claude Opus 5.5",
      "Claude Haiku 5.5",
      "Claude Sonnet 5.5",
      "Claude Opus 4.8",
    ]);
  });

  it("matches chat starts across alternate routes and keeps unused makers untouched", () => {
    const allSources = [
      source("codex", "gpt-6.1-terra", "GPT-6.1 Terra"),
      source("codex", "gpt-6.1-sol", "GPT-6.1 Sol"),
    ];
    const groups = groupModelsByMaker(allSources);
    const ordered = orderMakerModelsByUse(
      groups,
      // Started on an added account instance id — still matches GPT-6.1 Sol canonically.
      [{ instanceId: "codex-work", slug: "gpt-6.1-sol", at: daysAgo(1) }],
      allSources,
      now,
    );
    expect(ordered[0]!.models.map((entry) => entry.name)).toEqual(["GPT-6.1 Sol", "GPT-6.1 Terra"]);
    // Without uses inside the window, catalog order is preserved verbatim.
    expect(
      orderMakerModelsByUse(
        groups,
        [{ instanceId: "codex", slug: "gpt-6.1-sol", at: daysAgo(200) }],
        allSources,
        now,
      ),
    ).toBe(groups);
  });
});

describe("makerUsesOf", () => {
  it("counts only chats someone started, with a model and a readable start time", () => {
    const chat = (createdBy: string, createdAt: string, model?: string) => ({
      source: { createdBy },
      createdAt,
      ...(model ? { modelSelection: { instanceId: "claudeAgent", model } } : {}),
    });
    expect(
      makerUsesOf([
        chat("user", "2026-11-12T10:00:00.000Z", "claude-opus-5-5"),
        chat("agent", "2026-11-12T10:00:00.000Z", "gpt-6.1-sol"),
        chat("user", "not a date", "claude-opus-5-5"),
        chat("user", "2026-11-12T10:00:00.000Z"),
      ]),
    ).toEqual([
      {
        instanceId: "claudeAgent",
        slug: "claude-opus-5-5",
        at: Date.parse("2026-11-12T10:00:00.000Z"),
      },
    ]);
  });
});

describe("a model remembered on a gateway", () => {
  const provider = (
    instanceId: Instance,
    models: ReadonlyArray<readonly [slug: string, name: string]>,
  ) => ({
    instanceId,
    driver: instances[instanceId].driver,
    displayName: instances[instanceId].instanceName,
    models: models.map(([slug, name]) => ({ slug, name })),
  });
  const providers = [
    provider("opencode", [
      ["openrouter/meta/muse-ember", "Muse Ember"],
      ["meta/muse-ember-1.0", "Muse Ember 1.0"],
      ["openrouter/z-ai/glm-5.3-flash", "GLM-5.3 Flash"],
    ]),
    provider("muse", [
      ["muse-wonder-1.0", "Muse Wonder 1.0"],
      ["muse-ember-1.0", "Muse Ember 1.0"],
    ]),
    provider("pi_open_models", [["z-ai/glm-5.3-flash", "GLM-5.3 Flash"]]),
  ];
  const viaGateway = { instanceId: "opencode", slug: "openrouter/meta/muse-ember" };
  const viaPlan = { instanceId: "muse", slug: "muse-ember-1.0" };

  it("moves to the maker's own harness once that offers the model", () => {
    expect(ownHarnessRouteForRememberedModel(providers, viaGateway)).toEqual(viaPlan);
    expect(
      stickyModelRerouter({ memory: () => ({}) })(
        { instanceId: "opencode", model: "openrouter/meta/muse-ember" },
        providers,
      ),
    ).toEqual({ instanceId: "muse", model: "muse-ember-1.0" });
  });

  it("moves a Gemini model to Antigravity, Google's own agent on the plan", () => {
    const gemini = [
      provider("opencode", [["openrouter/google/gemini-4-neon", "Gemini 4 Neon"]]),
      provider("antigravity", [["gemini-4-neon", "Gemini 4 Neon"]]),
    ];
    expect(
      ownHarnessRouteForRememberedModel(gemini, {
        instanceId: "opencode",
        slug: "openrouter/google/gemini-4-neon",
      }),
    ).toEqual({ instanceId: "antigravity", slug: "gemini-4-neon" });
  });

  it("stays where it is when it already runs there, or the harness lacks it", () => {
    expect(ownHarnessRouteForRememberedModel(providers, viaPlan)).toBeNull();
    expect(
      ownHarnessRouteForRememberedModel([providers[0]!, providers[2]!], viaGateway),
    ).toBeNull();
    expect(
      ownHarnessRouteForRememberedModel(providers, { instanceId: "opencode", slug: "missing" }),
    ).toBeNull();
  });

  it("stays on a gateway picked over the maker's harness on this device", () => {
    const ember = findMakerModel(
      groupModelsByMaker([
        source("opencode", "openrouter/meta/muse-ember", "Muse Ember"),
        source("muse", "muse-ember-1.0", "Muse Ember 1.0"),
      ]),
      viaPlan,
    )!;
    const memory = { [ember.key]: { ...viaGateway, over: viaPlan } };
    expect(ownHarnessRouteForRememberedModel(providers, viaGateway, { memory })).toBeNull();
  });

  it("leaves a choice between harnesses alone when no maker's harness is involved", () => {
    // GLM ranks several harnesses; which one runs it is a preference, not a plan.
    expect(
      ownHarnessRouteForRememberedModel(providers, {
        instanceId: "opencode",
        slug: "openrouter/z-ai/glm-5.3-flash",
      }),
    ).toBeNull();
  });

  it("leaves a second harness set up for the same maker's model alone", () => {
    const qwen = [
      provider("claudeAgent_qwen4", [["qwen-latest-series-invite-1102", "Qwen4 (early access)"]]),
      provider("acpRegistry_qwen_code", [
        ["qwen-latest-series-invite-1102(openai)", "Qwen4 (early access)"],
      ]),
    ];
    const viaClaudeCode = {
      instanceId: "claudeAgent_qwen4",
      slug: "qwen-latest-series-invite-1102",
    };
    expect(ownHarnessRouteForRememberedModel(qwen, viaClaudeCode)).toBeNull();
    // And a pick of it saved before picks recorded their default still opens the model there.
    const model = findMakerModel(
      groupModelsByMaker([
        source("claudeAgent_qwen4", "qwen-latest-series-invite-1102", "Qwen4 (early access)"),
        source(
          "acpRegistry_qwen_code",
          "qwen-latest-series-invite-1102(openai)",
          "Qwen4 (early access)",
        ),
      ]),
      viaClaudeCode,
    )!;
    expect(defaultModelRoute(model)?.source.instanceId).toBe("acpRegistry_qwen_code");
    expect(defaultModelRoute(model, { lastUsed: viaClaudeCode })?.source.instanceId).toBe(
      "claudeAgent_qwen4",
    );
  });

  it("never sends a chat to a model hidden on the maker's harness", () => {
    expect(
      stickyModelRerouter({
        memory: () => ({}),
        preferences: { muse: { hiddenModels: ["muse-ember-1.0"] } },
      })({ instanceId: "opencode", model: "openrouter/meta/muse-ember" }, providers),
    ).toBeNull();
  });
});

describe("Devin's catalog, as it lists it live (Nov 2026)", () => {
  const groups = groupModelsByMaker([
    source("claudeAgent", "claude-opus-5-5", "Claude Opus 5.5"),
    source("codex", "gpt-6.2-sol", "GPT-6.2-Sol"),
    source("pi_open_models", "qwen/qwen3", "Qwen3"),
    source("acpRegistry_devin", "adaptive", "Adaptive"),
    source("acpRegistry_devin", "qwen3-max", "Qwen3 Max"),
    source("acpRegistry_devin", "swe-2-high", "SWE-2"),
    source("acpRegistry_devin", "swe-2-flash-medium", "SWE-2 Flash"),
    source("acpRegistry_devin", "claude-opus-5-5-medium", "Claude Opus 5.5"),
    source("acpRegistry_devin", "gpt-6-2-sol-medium", "GPT-6.2 Sol"),
    source("acpRegistry_devin", "kimi-k3-1-pro-max", "Kimi K3.1 Pro"),
    source("acpRegistry_devin", "nemotron-3-5-super-high", "Nemotron 3.5 Super"),
    source(
      "acpRegistry_devin",
      "fusion-claude-opus-5-5-medium-sidekick-swe-2-medium",
      "Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)",
    ),
  ]);
  const maker = (id: string) => groups.find((group) => group.maker.id === id)!;
  const model = (makerId: string, name: string) =>
    maker(makerId).models.find((entry) => entry.name === name)!;

  it("adds Devin as one more route to a model the plan's own harness runs first", () => {
    const opus = model("anthropic", "Claude Opus 5.5");
    expect(opus.routes.map((route) => route.source.instanceId)).toEqual([
      "claudeAgent",
      "acpRegistry_devin",
    ]);
    expect(defaultModelRoute(opus)?.source.instanceId).toBe("claudeAgent");
    const sol = maker("openai").models.find((entry) =>
      entry.routes.some((route) => route.source.slug === "gpt-6-2-sol-medium"),
    )!;
    expect(sol.routes.map((route) => route.source.instanceId)).toEqual([
      "codex",
      "acpRegistry_devin",
    ]);
    expect(defaultModelRoute(sol)?.source.instanceId).toBe("codex");
  });

  it("files SWE, Adaptive and Fusion under Cognition, run in Devin", () => {
    expect(maker("cognition").models.map((entry) => entry.name)).toEqual([
      "Adaptive",
      "SWE-2",
      "SWE-2 Flash",
      "Fusion (Claude Opus 5.5 + SWE-2)",
    ]);
    for (const entry of maker("cognition").models) {
      expect(defaultModelRoute(entry)?.source.instanceId).toBe("acpRegistry_devin");
    }
  });

  it("lists a provider's main account before an added one, whatever order they came in", () => {
    const route = (instanceId: string, driver: string, instanceName: string, slug: string) => ({
      instanceId,
      driver,
      instanceName,
      slug,
      name: "Claude Opus 5.5",
    });
    const [anthropic] = groupModelsByMaker([
      route("claudeAgent", "claudeAgent", "Max 1", "claude-opus-5-5"),
      route("antigravity_pro", "antigravity", "Google Pro", "claude-opus-5-5"),
      route("acpRegistry_kimi", "acpRegistry", "Kimi", "claude-opus-5-5"),
      route("antigravity", "antigravity", "Google Ultra", "claude-opus-5-5"),
      route("acpRegistry_devin", "acpRegistry", "Devin", "claude-opus-5-5-medium"),
    ]);
    expect(anthropic!.models[0]!.routes.map((entry) => entry.source.instanceId)).toEqual([
      "claudeAgent",
      "antigravity",
      "antigravity_pro",
      // Registry agents are separate products: they keep their own order.
      "acpRegistry_kimi",
      "acpRegistry_devin",
    ]);
  });

  it("never makes Devin the default over a route already there", () => {
    const [glm] = groupModelsByMaker([
      source("acpRegistry_devin", "glm-5-2", "GLM-5.2 High"),
      source("opencode", "opencode-go/glm-5.2", "GLM-5.2"),
    ]).flatMap((group) => group.models);
    expect(glm!.routes.map((route) => route.source.instanceId)).toEqual([
      "acpRegistry_devin",
      "opencode",
    ]);
    expect(defaultModelRoute(glm!)?.source.instanceId).toBe("opencode");
  });

  it("keeps other makers' models with their makers, and a name's own Max", () => {
    expect(maker("moonshot").models.map((entry) => entry.name)).toEqual(["Kimi K3.1 Pro"]);
    expect(maker(OTHER_MAKER_ID).models.map((entry) => entry.name)).toEqual(["Nemotron 3.5 Super"]);
    expect(
      maker("qwen")
        .models.map((entry) => entry.name)
        .sort(),
    ).toEqual(["Qwen3", "Qwen3 Max"]);
  });
});
