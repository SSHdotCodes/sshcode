import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  moveFavoriteModel,
  providerModelKey,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("groups favorites first while preserving provider model order inside each group", () => {
    const models = [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.4-mini" },
      { slug: "crest-alpha" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["gpt-5.5", "gpt-5.4-mini", "crest-alpha"],
        groupFavorites: true,
        modelOrder: ["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"],
      }).map((model) => model.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"]);
  });

  it("sorts the favorites view by provider order, then provider model order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.4-mini" },
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.5" },
      { instanceId: CODEX_WORK_ID, slug: "crest-alpha" },
      { instanceId: CLAUDE_ID, slug: "claude-opus-4-6" },
    ];
    const favoriteKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CODEX_WORK_ID, "crest-alpha"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favoriteKeys,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }).map((item) => item.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "claude-opus-4-6"]);
  });
});

describe("favorite order", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const favorites = [
    { provider: claude, model: "opus" },
    { provider: codex, model: "sol" },
    { provider: codex, model: "terra" },
  ];

  it("lists favorites in their saved order", () => {
    const items = [
      { instanceId: codex, slug: "sol" },
      { instanceId: codex, slug: "terra" },
      { instanceId: claude, slug: "opus" },
    ];
    expect(
      sortProviderModelItems(items, {
        favoriteOrder: favorites.map((favorite) =>
          providerModelKey(favorite.provider, favorite.model),
        ),
        instanceOrder: [codex, claude],
      }).map((item) => item.slug),
    ).toEqual(["opus", "sol", "terra"]);
  });

  it("moves a favorite and leaves unshown ones in their slots", () => {
    const shown = new Set([providerModelKey(claude, "opus"), providerModelKey(codex, "terra")]);
    expect(
      moveFavoriteModel(
        favorites,
        shown,
        providerModelKey(codex, "terra"),
        providerModelKey(claude, "opus"),
      )?.map((favorite) => favorite.model),
    ).toEqual(["terra", "sol", "opus"]);
    const all = new Set(
      favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model)),
    );
    expect(
      moveFavoriteModel(
        favorites,
        all,
        providerModelKey(claude, "opus"),
        providerModelKey(codex, "terra"),
      )?.map((favorite) => favorite.model),
    ).toEqual(["sol", "terra", "opus"]);
    expect(
      moveFavoriteModel(
        favorites,
        all,
        providerModelKey(codex, "sol"),
        providerModelKey(codex, "sol"),
      ),
    ).toBeNull();
  });
});
