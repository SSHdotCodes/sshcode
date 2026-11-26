import {
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { unavailableGoogleLimits } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { createModelPickerCatalog, resolveModelPickerFavorites } from "./modelPickerCatalog.ts";
import { groupModelsByMaker, type ModelRouteRef } from "./modelMakers.ts";

function model(slug: string, extra: Partial<ServerProviderModel> = {}): ServerProviderModel {
  return { slug, name: slug, isCustom: false, capabilities: null, ...extra };
}

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
  extra: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-07T00:00:00.000Z",
    version: null,
    models,
    slashCommands: [],
    skills: [],
    ...extra,
  };
}

function sources(providers: ReadonlyArray<ServerProvider>) {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      ...model,
      instanceId: provider.instanceId,
      driver: provider.driver,
      instanceName: provider.displayName ?? provider.driver,
    })),
  );
}

const opus = model("claude-opus-5-5", { name: "Claude Opus 5.5" });
const claude = provider("claudeAgent", "claudeAgent", [opus]);
const generic = provider("opencode", "opencode", [model("openrouter/anthropic/claude-opus-5-5")]);
const ref = (instanceId: string, slug: string): ModelRouteRef => ({ instanceId, slug });

describe("model picker catalog", () => {
  it("keeps frontier makers in their own harnesses and open makers on generic routes", () => {
    const natives = [
      claude,
      provider("codex", "codex", [model("gpt-6.1-sol")]),
      provider("grok", "grok", [model("grok-build")]),
      ...[
        ["gemini", "gemini-4-pro"],
        ["qwen-code", "qwen4"],
        ["kimi", "kimi-k3.1-pro"],
        ["mistral-vibe", "mistral-large-4"],
      ].map(([agent, slug]) =>
        provider(`renamed_${agent}`, "acpRegistry", [model(slug!)], {
          displayName: "My account",
          iconUrl: officialAcpRegistryIconUrlForAgentId(agent)!,
        }),
      ),
    ];
    const frontiers = natives.flatMap((native) => native.models);
    const generics = ["opencode", "pi", "cursor", "acpRegistry"].map((driver) =>
      provider(
        `generic_${driver}`,
        driver,
        [
          ...frontiers.map((entry) => model(`openrouter/${entry.slug}`)),
          model("deepseek-v4.1"),
          model("glm-5.3"),
          model("llama-4"),
        ],
        { displayName: driver === "acpRegistry" ? "Hermes" : driver },
      ),
    );
    const providers = [...natives, ...generics];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(
      catalog.sources
        .filter((source) => source.instanceId.startsWith("generic_"))
        .map((source) => source.slug),
    ).toEqual(generics.flatMap(() => ["deepseek-v4.1", "glm-5.3"]));
    expect(
      catalog.sources.filter((source) => !source.instanceId.startsWith("generic_")),
    ).toHaveLength(frontiers.length);
  });

  it.each([
    { enabled: false },
    { installed: false },
    { status: "error" as const },
    { availability: "unavailable" as const },
    { auth: { status: "unauthenticated" as const } },
  ])("keeps generic routes when the native harness cannot run: %j", (extra) => {
    const providers = [{ ...claude, ...extra }, generic];
    expect(createModelPickerCatalog(sources([generic]), { providers }).sources).toHaveLength(1);
  });

  it("scopes routing and supersessions to each environment, including other instance ids", () => {
    const studioClaude = provider("studio_claude", "claudeAgent", [opus]);
    const studioOpenCode = provider("studio_opencode", "opencode", generic.models);
    const providers = [studioClaude, studioOpenCode];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.instanceId,
      ),
    ).toEqual(["studio_claude"]);
    // A different environment with no native Claude instance keeps its generic route.
    expect(
      createModelPickerCatalog(sources([studioOpenCode]), { providers: [studioOpenCode] }).sources,
    ).toHaveLength(1);
    // Continuation filtering must not change which harnesses the environment has.
    expect(
      createModelPickerCatalog(sources([generic]), { providers: [claude, generic] }).sources,
    ).toEqual([]);
  });

  it("preserves explicit model lists without exempting an instance's discovered catalog", () => {
    const qwen = model("qwen4");
    const providers = [
      claude,
      provider("qwen_native", "acpRegistry", [qwen]),
      provider("claudeAgent_qwen4", "claudeAgent", [qwen]),
      provider("pi_open", "pi", [model("openrouter/qwen4"), model("openrouter/claude-opus-5-5")]),
      provider("hermes_open", "acpRegistry", [model("glm-5.3", { isCustom: true })]),
      provider("studio_opencode", "opencode", [model("blackwell/qwen4", { isCustom: true })]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), {
      providers,
      providerInstances: {
        [ProviderInstanceId.make("qwen_native")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: "qwen-code" },
        },
        [ProviderInstanceId.make("claudeAgent_qwen4")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: [{ slug: "qwen4", name: "Qwen4" }] },
        },
        [ProviderInstanceId.make("pi_open")]: {
          driver: ProviderDriverKind.make("pi"),
          config: { customModels: ["openrouter/qwen4"] },
        },
      },
    });
    expect(catalog.sources.map((source) => `${source.instanceId}:${source.slug}`)).toEqual([
      "claudeAgent:claude-opus-5-5",
      "qwen_native:qwen4",
      "claudeAgent_qwen4:qwen4",
      "pi_open:openrouter/qwen4",
      "hermes_open:glm-5.3",
      "studio_opencode:blackwell/qwen4",
    ]);
  });

  it("hides legacy and superseded releases using the capability catalog's version rules", () => {
    const providers = [
      provider("claudeAgent", "claudeAgent", [
        opus,
        model("claude-opus-5"),
        model("claude-opus-4-8"),
        model("claude-fable-5-1"),
        model("claude-fable-5"),
      ]),
      provider("codex", "codex", [
        model("gpt-6.1-sol"),
        model("gpt-6-sol"),
        model("gpt-6-astra"),
        model("gpt-obsolete", { isLegacy: true }),
      ]),
      provider("grok", "grok", [model("grok-4.5"), model("grok-4")]),
      provider("google_old", "opencode", [model("gemini-old", { isLegacy: true })]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(catalog.sources.map((source) => source.slug)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "grok-4.5",
    ]);
    expect(catalog.groups.map((group) => group.maker.id)).not.toContain("google");
  });

  it("compares releases across routes before applying native routing", () => {
    const providers = [
      provider("codex", "codex", [model("gpt-6-sol")]),
      provider("opencode", "opencode", [model("openai/gpt-6.1-sol")]),
    ];
    expect(createModelPickerCatalog(sources(providers), { providers }).sources).toEqual([]);
  });

  it.each(["claude-opus-5", "Claude Opus 5", "CLAUDE OPUS 5", "opus 5", "claude", "Anthropic"])(
    "search finds an old model by its name, id or maker: %s",
    (search) => {
      const old = model("claude-opus-5", { name: "Claude Opus 5" });
      const providers = [provider("claudeAgent", "claudeAgent", [opus, old])];
      expect(
        createModelPickerCatalog(sources(providers), { providers, search }).sources.map(
          (source) => source.slug,
        ),
      ).toContain(old.slug);
      expect(
        createModelPickerCatalog(sources(providers), { providers }).sources.map(
          (source) => source.slug,
        ),
      ).not.toContain(old.slug);
    },
  );

  it("search reaches models the curation hides but keeps frontier makers in their harness", () => {
    const providers = [
      claude,
      provider("opencode", "opencode", [
        model("openrouter/google/gemma-3-27b-it", { name: "Gemma 3 27B IT" }),
        model("openrouter/meta-llama/llama-4-maverick", { name: "Llama 4 Maverick" }),
        model("openrouter/acme/obscure-coder-7b", { name: "Obscure Coder 7B" }),
        model("openrouter/anthropic/claude-opus-5-5", { name: "Claude Opus 5.5" }),
      ]),
    ];
    const search = (query: string) =>
      createModelPickerCatalog(sources(providers), { providers, search: query }).sources.map(
        (source) => source.slug,
      );
    // The catalog adds what the search reaches; the picker's ranker then narrows the list.
    const hidden = (query: string) => search(query).filter((slug) => slug !== "claude-opus-5-5");
    expect(hidden("")).toEqual([]);
    expect(hidden("gemma 3")).toEqual(["openrouter/google/gemma-3-27b-it"]);
    expect(hidden("google")).toEqual(["openrouter/google/gemma-3-27b-it"]);
    expect(hidden("llama")).toEqual(["openrouter/meta-llama/llama-4-maverick"]);
    expect(hidden("obscure coder")).toEqual(["openrouter/acme/obscure-coder-7b"]);
    expect(hidden("opus 5.5")).toEqual([]);
    expect(hidden("x")).toEqual([]);
  });

  it("keeps a model starred from search listed, but no old version or other route of a frontier model", () => {
    const obscure = "openrouter/acme/obscure-coder-7b";
    const providers = [
      provider("claudeAgent", "claudeAgent", [opus, model("claude-opus-5")]),
      provider("opencode", "opencode", [
        model(obscure, { name: "Obscure Coder 7B" }),
        model("openrouter/acme/other-coder-7b", { name: "Other Coder 7B" }),
        model("openrouter/anthropic/claude-opus-5-5", { name: "Claude Opus 5.5" }),
      ]),
    ];
    const favorites = [
      ref("opencode", obscure),
      ref("claudeAgent", "claude-opus-5"),
      ref("opencode", "openrouter/anthropic/claude-opus-5-5"),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers, favorites });
    expect(catalog.sources.map((source) => source.slug)).toEqual([opus.slug, obscure]);
    expect(
      resolveModelPickerFavorites(favorites, catalog.resolveFavorite).map(({ target }) => target),
    ).toEqual([ref("opencode", obscure), ref("claudeAgent", opus.slug)]);
    // Without the star, only search reaches it.
    expect(
      createModelPickerCatalog(sources(providers), { providers }).resolveFavorite(favorites[0]!),
    ).toBeNull();
  });

  it("lists Thinking Machines' newest Inkling generation and finds older ones by search", () => {
    const providers = [
      provider("opencode", "opencode", [
        model("opencode/inkling-2-small-free", { name: "Inkling 2 Small Free" }),
        model("openrouter/thinkingmachines/inkling", { name: "Inkling" }),
        model("openrouter/thinkingmachines/inkling-small", { name: "Inkling Small" }),
        model("requesty/inkling-256k", { name: "Inkling 256K" }),
      ]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(catalog.sources.map((source) => source.slug)).toEqual(["opencode/inkling-2-small-free"]);
    expect(catalog.groups.map((group) => group.maker.label)).toEqual(["Thinking Machines"]);
    expect(
      createModelPickerCatalog(sources(providers), {
        providers,
        search: "thinking machines",
      }).sources.map((source) => source.slug),
    ).toHaveLength(4);
    expect(
      createModelPickerCatalog(sources(providers), {
        providers,
        search: "inkling 2 small",
      }).sources.map((source) => source.slug),
    ).toEqual(["opencode/inkling-2-small-free"]);
  });

  it("finds Tencent's Hy models by the maker's name, though their ids don't carry it", () => {
    const providers = [
      provider("opencode", "opencode", [
        model("opencode/hy4-flash-free", { name: "Hy4 flash Free" }),
        model("opencode-go/hy4-flash-free", { name: "Hy4 flash Free" }),
        model("opencode-go/hy4", { name: "Hy4" }),
        model("openrouter/tencent/hy-mt2-7b", { name: "Hy-MT2-7B" }),
      ]),
    ];
    const found = (search: string) =>
      createModelPickerCatalog(sources(providers), { providers, search }).sources.map(
        (source) => source.slug,
      );
    // Not a curated maker: only a search lists it.
    expect(createModelPickerCatalog(sources(providers), { providers }).sources).toEqual([]);
    expect(found("tencent hy4 flash")).toEqual([
      "opencode/hy4-flash-free",
      "opencode-go/hy4-flash-free",
    ]);
    expect(found("hunyuan")).toEqual([
      "opencode/hy4-flash-free",
      "opencode-go/hy4-flash-free",
      "opencode-go/hy4",
    ]);
    expect(
      createModelPickerCatalog(sources(providers), {
        providers,
        search: "tencent hy4 flash",
      }).groups.map((group) => group.maker.label),
    ).toEqual(["Tencent"]);
  });

  it("keeps the current old/non-native route selected, without reviving other hidden models", () => {
    const providers = [
      claude,
      provider("opencode", "opencode", [
        model("anthropic/claude-opus-5", { isLegacy: true }),
        model("anthropic/claude-opus-4-8"),
      ]),
    ];
    const selected = ref("opencode", "anthropic/claude-opus-5");
    const catalog = createModelPickerCatalog(sources(providers), {
      providers,
      selected: [selected],
    });
    expect(catalog.sources.map((source) => source.slug)).toEqual([opus.slug, selected.slug]);
  });

  it("maps stored favorites to the same model's native route and retains their original mutation keys", () => {
    const providers = [claude, generic];
    const favorite = ref("opencode", generic.models[0]!.slug);
    const native = ref("claudeAgent", opus.slug);
    const catalog = createModelPickerCatalog(sources(providers), {
      providers,
      selected: [favorite],
    });
    expect(catalog.resolveFavorite(favorite)).toEqual(native);
    expect(catalog.resolveFavorite(native)).toEqual(native);
    expect(resolveModelPickerFavorites([favorite, native], catalog.resolveFavorite)).toEqual([
      { original: favorite, target: native },
      { original: native, target: native },
    ]);
    expect(catalog.resolveFavorite(ref("absent", opus.slug))).toBeNull();
  });

  it("does not turn an old favorite into a different version or restore its hidden route", () => {
    const old = model("claude-opus-5");
    const providers = [
      provider("claudeAgent", "claudeAgent", [opus, old]),
      provider("opencode", "opencode", [model(`anthropic/${old.slug}`)]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(catalog.resolveFavorite(ref("opencode", `anthropic/${old.slug}`))).toBeNull();
  });

  it("keeps only current open generations across sizes and variants, including MiniMax M3 and M3.1 Flash", () => {
    const current = [
      "qwen/qwen3.8-max-prime",
      "minimax/minimax-m3",
      "minimax/minimax-m3.1-flash",
      "deepseek/deepseek-v4.1-flash",
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3.1",
      "mistralai/mistral-large-4",
    ];
    const old = [
      "qwen/qwen2.5-72b-instruct",
      "qwen/qwen2.5-7b-instruct",
      "qwen/qwen2.5-coder-32b-instruct",
      "minimax/minimax-m1",
      "minimax/minimax-m2.5",
      "minimax/minimax-m2.7",
      "deepseek/deepseek-v3.2",
      "z-ai/glm-4.7",
      "moonshotai/kimi-k2-thinking",
      "mistralai/mistral-large-3",
    ];
    const providers = [
      provider(
        "opencode",
        "opencode",
        [...current, ...old].map((slug) => model(slug)),
      ),
    ];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.slug,
      ),
    ).toEqual(current);
  });

  it("keeps only the newest Gemini flagship and Flash, dropping Flash Lite and old previews", () => {
    const current = ["google/gemini-4-argon", "google/gemini-3.8-flash"];
    const old = [
      "google/gemini-2.5-pro-preview-06-05",
      "google/gemini-3-flash",
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.1-flash-lite-preview",
      "google/gemini-3.1-pro-preview",
    ];
    const providers = [
      provider(
        "opencode",
        "opencode",
        [...current, ...old].map((slug) => model(slug)),
      ),
    ];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.slug,
      ),
    ).toEqual(current);
  });

  it("keeps only current open releases, dropping retired lines, dated copies, Flint and non-text models", () => {
    const current = [
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/z-ai/glm-5.3",
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/qwen/qwen3.8-max",
      "openrouter/google/gemini-3.8-flash",
    ];
    const old = [
      "openrouter/deepseek/deepseek-chat",
      "openrouter/deepseek/deepseek-r1-0528",
      "openrouter/deepseek/deepseek-v4-flash-vision-exp",
      "openrouter/deepseek/deepseek-v4-pro",
      "openrouter/deepseek/deepseek-v4-pro-0813",
      "openrouter/z-ai/glm-5-turbo",
      "openrouter/z-ai/glm-5v-turbo",
      "openrouter/qwen/qwen3.6-plus",
      "openrouter/google/gemma-4-31b-it",
      "openrouter/google/gemini-omni-1.2-flash",
      "openrouter/google/lyria-3-pro-preview",
      "openrouter/minimax/minimax-01",
      "openrouter/recursive/flint",
      "opencode/flint-40b-free",
    ];
    const providers = [
      provider(
        "opencode",
        "opencode",
        [...current, ...old].map((slug) => model(slug)),
      ),
    ];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.slug,
      ),
    ).toEqual(current);
  });

  it("retires every older DeepSeek tier, keeping tiers and dated snapshots of the newest release", () => {
    const current = ["deepseek-v4.1-flash-1017", "deepseek-v4.1-pro"];
    const old = ["deepseek-v4-pro-0813", "deepseek-v4-flash"];
    const providers = [
      provider(
        "opencode",
        "opencode",
        [...current, ...old].map((slug) => model(slug)),
      ),
    ];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.slug,
      ),
    ).toEqual(current);
  });

  it("files Gemini 3.1 Pro as old once a Gemini 4 Argon is listed, even under provider line families", () => {
    const providers = [
      provider("opencode", "opencode", [
        model("gemini-3.1-pro", { name: "Gemini 3.1 Pro Preview", family: "gemini:pro" }),
        model("gemini-4", { name: "Gemini 4", family: "gemini:argon" }),
        model("gemini-4-carbon", { family: "gemini:carbon" }),
      ]),
    ];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.slug,
      ),
    ).toEqual(["gemini-4", "gemini-4-carbon"]);
  });

  it("shows Muse's OpenCode routes beside Muse Code under one row", () => {
    const muse = provider("muse", "muse", [model("muse-ember-1.0"), model("muse-spark-1.3")]);
    const opencode = provider("opencode", "opencode", [
      model("opencode/muse-ember-1.0", { name: "Muse Ember 1.0" }),
      model("opencode-go/muse-spark-1.3-contributor"),
    ]);
    const providers = [muse, opencode];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    const ember = catalog.groups
      .flatMap((group) => group.models)
      .find((entry) => entry.routes.some((route) => route.source.slug === "muse-ember-1.0"));
    expect(ember?.routes.map((route) => `${route.source.instanceId}:${route.source.slug}`)).toEqual(
      ["muse:muse-ember-1.0", "opencode:opencode/muse-ember-1.0"],
    );
  });

  it("lists Antigravity first for a Gemini model and keeps its gateways after it", () => {
    const antigravity = provider("antigravity", "antigravity", [model("gemini-4-neon")]);
    const opencode = provider("opencode", "opencode", [
      model("opencode/gemini-4-neon", { name: "Gemini 4 Neon" }),
      // Antigravity's plan does not list Carbon; its gateway route must stay.
      model("opencode/gemini-4-carbon", { name: "Gemini 4 Carbon" }),
    ]);
    const providers = [opencode, antigravity];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    const routesOf = (slug: string) =>
      catalog.groups
        .flatMap((group) => group.models)
        .find((entry) => entry.routes.some((route) => route.source.slug === slug))
        ?.routes.map((route) => `${route.source.instanceId}:${route.source.slug}`);
    expect(routesOf("gemini-4-neon")).toEqual([
      "antigravity:gemini-4-neon",
      "opencode:opencode/gemini-4-neon",
    ]);
    expect(routesOf("opencode/gemini-4-carbon")).toEqual(["opencode:opencode/gemini-4-carbon"]);
  });

  it("shows Devin's routes beside the native harness's, which still leads", () => {
    const antigravity = provider("antigravity", "antigravity", [
      model("gemini-4-hydrogen", { name: "Gemini 4 Hydrogen" }),
    ]);
    const devin = provider(
      "acpRegistry_devin",
      "acpRegistry",
      [
        model("claude-opus-5-5-medium", { name: "Claude Opus 5.5" }),
        model("gemini-4-hydrogen-medium", { name: "Gemini 4 Hydrogen" }),
        model("gemini-4-carbon-medium", { name: "Gemini 4 Carbon" }),
        model("gemini-3-7-flash-medium", { name: "Gemini 3.7 Flash" }),
        model("gemini-3-8-flash-medium", { name: "Gemini 3.8 Flash" }),
        model("claude-opus-4-6-thinking-1m", { name: "Claude Opus 4.6 Thinking 1M" }),
        model("claude-5-fable-medium", { name: "Claude Fable 5" }),
        model("claude-fable-5-2-medium", { name: "Claude Fable 5.2" }),
        model("swe-2-high", { name: "SWE-2" }),
        model("swe-2-flash-medium", { name: "SWE-2 Flash" }),
        model("swe-1-7-medium", { name: "SWE-1.7" }),
        model("swe-1-6", { name: "SWE-1.6" }),
      ],
      { displayName: "Devin", iconUrl: officialAcpRegistryIconUrlForAgentId("devin") ?? undefined },
    );
    const providers = [devin, generic, claude, antigravity];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    const routesOf = (slug: string) =>
      catalog.groups
        .flatMap((group) => group.models)
        .find((entry) => entry.routes.some((route) => route.source.slug === slug))
        ?.routes.map((route) => `${route.source.instanceId}:${route.source.slug}`);
    expect(routesOf("claude-opus-5-5")).toEqual([
      "claudeAgent:claude-opus-5-5",
      "acpRegistry_devin:claude-opus-5-5-medium",
    ]);
    expect(routesOf("gemini-4-hydrogen")).toEqual([
      "antigravity:gemini-4-hydrogen",
      "acpRegistry_devin:gemini-4-hydrogen-medium",
    ]);
    expect(routesOf("swe-2-high")).toEqual(["acpRegistry_devin:swe-2-high"]);
    // A current release only Devin offers stays; older lines and generations hide.
    expect(routesOf("gemini-4-carbon-medium")).toEqual([
      "acpRegistry_devin:gemini-4-carbon-medium",
    ]);
    expect(routesOf("swe-2-flash-medium")).toEqual(["acpRegistry_devin:swe-2-flash-medium"]);
    for (const old of [
      "gemini-3-7-flash-medium",
      "claude-opus-4-6-thinking-1m",
      "claude-5-fable-medium",
      "swe-1-7-medium",
      "swe-1-6",
    ])
      expect(routesOf(old)).toBeUndefined();
    expect(routesOf("claude-fable-5-2-medium")).toEqual([
      "acpRegistry_devin:claude-fable-5-2-medium",
    ]);
  });

  it("shows Claude on a Google AI plan beside Claude Code, but not on a Google API key", () => {
    const google = (instanceId: string, type: string) =>
      provider(
        instanceId,
        "antigravity",
        [
          model("gemini-4-neon", { name: "Gemini 4 Neon" }),
          model("gemini-3.8-flash", { name: "Gemini 3.8 Flash" }),
          model("claude-opus-5-5", { name: "Claude Opus 5.5" }),
        ],
        { auth: { status: "authenticated", type } },
      );
    const routesOf = (providers: ReadonlyArray<ServerProvider>, slug: string) =>
      createModelPickerCatalog(sources(providers), { providers })
        .groups.flatMap((group) => group.models)
        .find((entry) => entry.routes.some((route) => route.source.slug === slug))
        ?.routes.map((route) => route.source.instanceId);
    const ultra = google("antigravity", "oauth-personal");
    const plan = [claude, { ...ultra, usageLimits: unavailableGoogleLimits(ultra.checkedAt) }];
    expect(routesOf(plan, "claude-opus-5-5")).toEqual(["claudeAgent", "antigravity"]);
    // Its own Gemini models are native routes, not plan routes an older major would hide.
    expect(routesOf(plan, "gemini-3.8-flash")).toEqual(["antigravity"]);
    const apiKey = [claude, google("antigravity_key", "gemini-api-key")];
    expect(routesOf(apiKey, "claude-opus-5-5")).toEqual(["claudeAgent"]);

    // Even alongside Gemini CLI, Antigravity's own Gemini routes stay native (not hidden by major
    // version on OAuth, and not hidden by Gemini CLI's native routing on an API key).
    const geminiCli = provider(
      "acpRegistry_gemini",
      "acpRegistry",
      [model("gemini-4-pro", { name: "Gemini 4 Pro" })],
      { iconUrl: officialAcpRegistryIconUrlForAgentId("gemini")! },
    );
    const planWithGeminiCli = [claude, geminiCli, google("antigravity", "oauth-personal")];
    expect(routesOf(planWithGeminiCli, "gemini-3.8-flash")).toEqual(["antigravity"]);
    expect(routesOf(planWithGeminiCli, "gemini-4-neon")).toEqual(["antigravity"]);
    const apiKeyWithGeminiCli = [claude, geminiCli, google("antigravity_key", "gemini-api-key")];
    expect(routesOf(apiKeyWithGeminiCli, "gemini-4-neon")).toEqual(["antigravity_key"]);
    expect(routesOf(apiKeyWithGeminiCli, "claude-opus-5-5")).toEqual(["claudeAgent"]);
  });

  it("keeps deliberate open models even when a newer generation is in a generic catalog", () => {
    const providers = [
      provider("opencode", "opencode", [
        model("qwen/qwen3.8-max-prime"),
        model("qwen/qwen2.5-72b"),
      ]),
      provider("studio_opencode", "opencode", [model("blackwell/qwen2.5-32b", { isCustom: true })]),
      provider(
        "qwen4",
        "acpRegistry",
        [model("qwen-latest-series-invite-1102(openai)", { isCustom: true, name: "Qwen4" })],
        { iconUrl: officialAcpRegistryIconUrlForAgentId("qwen-code")! },
      ),
    ];
    expect(
      createModelPickerCatalog(sources(providers), { providers }).sources.map(
        (source) => source.slug,
      ),
    ).toEqual(["blackwell/qwen2.5-32b", "qwen-latest-series-invite-1102(openai)"]);
  });

  it("removes Llama and community finetunes while keeping Muse and curated first-party open models", () => {
    const providers = [
      provider("opencode", "opencode", [
        model("meta-llama/llama-4-maverick"),
        model("sao10k/l3-lunaris-8b"),
        model("sao10k/l31-euryale-70b"),
        model("aion-labs/aion-rp-v1", { family: "llama" }),
        model("tngtech/deepseek-roleplay"),
        model("other/unknown-roleplay"),
        model("meta-llama/muse-spark"),
        model("deepseek/deepseek-v4.1"),
      ]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(catalog.sources.map((source) => source.slug)).toEqual([
      "meta-llama/muse-spark",
      "deepseek/deepseek-v4.1",
    ]);
    expect(catalog.groups.map((group) => group.maker.id)).toEqual(["deepseek", "muse"]);
  });

  it("never exempts custom Anthropic, OpenAI or xAI gateway routes from native routing", () => {
    const providers = [
      claude,
      provider("studio_hermes", "acpRegistry", [{ ...opus, isCustom: true }]),
      provider("hermes_anthropic", "acpRegistry", [opus]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), {
      providers,
      providerInstances: {
        [ProviderInstanceId.make("hermes_anthropic")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { customModels: [opus.slug] },
        },
      },
    });
    expect(catalog.sources.map((source) => source.instanceId)).toEqual([claude.instanceId]);
    expect(catalog.groups[0]!.models[0]!.routes).toHaveLength(1);
  });

  it("folds advertised latest aliases into their canonical selection, including favorites", () => {
    const providers = [
      provider("opencode", "opencode", [
        model("deepseek/deepseek-v4.1", { aliases: ["deepseek/deepseek-latest"] }),
        model("deepseek/deepseek-latest"),
      ]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(catalog.sources.map((source) => source.slug)).toEqual(["deepseek/deepseek-v4.1"]);
    expect(catalog.resolveFavorite(ref("opencode", "deepseek/deepseek-latest"))).toEqual(
      ref("opencode", "deepseek/deepseek-v4.1"),
    );
  });

  it("drops duplicate latest aliases and dated checkpoints without inventing another release order", () => {
    const providers = [
      provider("grok", "grok", [model("grok-build", { isDefault: true }), model("grok-latest")]),
      provider("opencode", "opencode", [
        model("deepseek/deepseek-v4.1"),
        model("deepseek/deepseek-v4.1-20261017"),
      ]),
    ];
    const catalog = createModelPickerCatalog(sources(providers), { providers });
    expect(catalog.sources.map((source) => source.slug)).toEqual([
      "grok-build",
      "deepseek/deepseek-v4.1",
    ]);
    expect(catalog.resolveFavorite(ref("grok", "grok-latest"))).toEqual(ref("grok", "grok-build"));
  });

  it("shrinks a representative multi-harness setup without dropping its deliberate open-model routes", () => {
    const latest = [
      opus,
      model("claude-fable-5-1"),
      model("gpt-6.1-sol"),
      model("grok-build"),
      model("qwen3.8-max-prime"),
      model("kimi-k3.1"),
      model("mistral-large-4"),
      model("deepseek-v4.1"),
      model("glm-5.3"),
      model("minimax-m3"),
      model("minimax-m3.1-flash"),
      model("muse-spark"),
    ];
    const older = [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5",
      "gpt-6-sol",
      "grok-4.20",
      "grok-latest",
      "qwen2.5-72b-instruct",
      "qwen2.5-coder-32b-instruct",
      "kimi-k2-thinking",
      "mistral-large-3",
      "deepseek-v3.2",
      "glm-4.7",
      "minimax-m1",
      "minimax-m2.5",
      "minimax-m2.7",
      "llama-4-maverick",
      "sao10k/l3-lunaris-8b",
      "aion-labs/aion-rp-v1",
      "other/unknown-roleplay",
    ].map((slug) => model(slug));
    const providers = [
      provider("claudeAgent", "claudeAgent", [
        opus,
        model("claude-fable-5-1"),
        ...older.slice(0, 3),
      ]),
      provider("codex", "codex", [latest[2]!, older[3]!]),
      provider("grok", "grok", [latest[3]!]),
      provider("qwen_code", "acpRegistry", [model("qwen4", { isCustom: true })], {
        iconUrl: officialAcpRegistryIconUrlForAgentId("qwen-code")!,
      }),
      provider("kimi", "acpRegistry", [latest[5]!], {
        iconUrl: officialAcpRegistryIconUrlForAgentId("kimi")!,
      }),
      provider("vibe", "acpRegistry", [latest[6]!], {
        iconUrl: officialAcpRegistryIconUrlForAgentId("mistral-vibe")!,
      }),
      provider(
        "opencode",
        "opencode",
        ["opencode", "openrouter", "github-copilot"].flatMap((gateway) =>
          [...latest, ...older].map((entry) => ({
            ...entry,
            slug: `${gateway}/${entry.slug}`,
            subProvider: gateway,
          })),
        ),
      ),
      ...["pi", "hermes"].map((id) =>
        provider(id, id === "hermes" ? "acpRegistry" : id, [...latest, ...older]),
      ),
      provider("studio_opencode", "opencode", [
        model("blackwell/qwen3-32b", { isCustom: true }),
        model("blackwell/glm-5.3", { isCustom: true }),
      ]),
      provider("claudeAgent_qwen4", "claudeAgent", [model("qwen4", { isCustom: true })]),
    ];
    const all = sources(providers);
    const before = groupModelsByMaker(all);
    const after = createModelPickerCatalog(all, { providers }).groups;
    const counts = (groups: typeof before) => ({
      makers: groups.length,
      models: groups.reduce((sum, group) => sum + group.models.length, 0),
      routes: groups.reduce(
        (sum, group) => sum + group.models.reduce((n, entry) => n + entry.routes.length, 0),
        0,
      ),
    });
    expect({ before: counts(before), after: counts(after) }).toEqual({
      before: { makers: 11, models: 33, routes: 169 },
      after: { makers: 10, models: 13, routes: 35 },
    });
  });
});
