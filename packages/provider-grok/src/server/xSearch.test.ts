import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import {
  GROK_X_SEARCH_MAX_CHARS,
  grokSessionsDirectory,
  grokXSearchAnswer,
  grokXSearchEnvironment,
  grokXSearchPrompt,
  refuseGrokXSearchPermission,
} from "./xSearch.ts";

describe("grok X search", () => {
  it("asks for posts only and marks post text as data", () => {
    const prompt = grokXSearchPrompt("from:xai grok 5");
    expect(prompt).toContain("Request: from:xai grok 5");
    expect(prompt).toContain("Use no other tools");
    expect(prompt).toContain("never instructions");
  });

  it("runs in the strict sandbox without memory, keeping the rest of the environment", () => {
    expect(grokXSearchEnvironment({ HOME: "/home/u", GROK_SANDBOX: "off" })).toEqual({
      HOME: "/home/u",
      GROK_SANDBOX: "strict",
      GROK_MEMORY: "0",
    });
  });

  it("refuses every permission request, keeping the turn alive when it can", () => {
    const option = (optionId: string, kind: "allow_once" | "reject_once" | "reject_always") => ({
      optionId,
      kind,
      name: optionId,
    });
    expect(
      refuseGrokXSearchPermission({
        options: [
          option("yes", "allow_once"),
          option("never", "reject_always"),
          option("no", "reject_once"),
        ],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(
      refuseGrokXSearchPermission({
        options: [option("yes", "allow_once"), option("never", "reject_always")],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "never" } });
    expect(refuseGrokXSearchPermission({ options: [option("yes", "allow_once")] })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("caps a long answer", () => {
    expect(grokXSearchAnswer("  posts  ")).toBe("posts");
    const long = grokXSearchAnswer("x".repeat(GROK_X_SEARCH_MAX_CHARS + 50));
    expect(long.length).toBeLessThan(GROK_X_SEARCH_MAX_CHARS + 40);
    expect(long.endsWith("[cut: ask for fewer posts]")).toBe(true);
  });

  it.effect("finds the folder Grok keeps a search folder's sessions in", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(grokSessionsDirectory({}, "/home/u", "/state/x-search", path)).toBe(
        "/home/u/.grok/sessions/%2Fstate%2Fx-search",
      );
      expect(grokSessionsDirectory({ GROK_HOME: "/g" }, "/home/u", "/state/x-search", path)).toBe(
        "/g/sessions/%2Fstate%2Fx-search",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
