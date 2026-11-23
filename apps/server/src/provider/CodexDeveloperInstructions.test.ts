import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  buildCodexBrowserContext,
  buildCodexDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexDeveloperInstructions", () => {
  it("keeps every fallback plan invariant within the compact budget", () => {
    const text = buildCodexDeveloperInstructions("plan");
    NodeAssert.ok(text.length <= 3_000);
    for (const rule of [
      "developer message explicitly ends it",
      "User requests to execute mean plan the execution",
      "update_plan",
      "never tracked files",
      "Do not implement",
      "three phases",
      "Explore",
      "high-impact ambiguities",
      "decision complete",
      "request_user_input",
      "2-4 meaningful",
      "record the default",
      "plan-only",
      "test cases",
      "Revisions replace the entire block",
      "reproduce the prior block unchanged",
    ])
      NodeAssert.ok(text.toLowerCase().includes(rule.toLowerCase()), rule);
    NodeAssert.equal(text.match(/^<proposed_plan>$/gm)?.length, 1);
    NodeAssert.equal(text.match(/^<\/proposed_plan>$/gm)?.length, 1);
  });
  it("keeps the collaboration-mode prompts for each mode", () => {
    NodeAssert.match(
      buildCodexDeveloperInstructions("default"),
      /^<collaboration_mode># Collaboration Mode: Default/,
    );
    NodeAssert.match(buildCodexDeveloperInstructions("plan"), /^<collaboration_mode># Plan Mode/);
  });

  it("describes Markdown media support in a single runtime line", () => {
    const instructions = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
    NodeAssert.match(
      instructions,
      /^<runtime_info>.*images and videos.*Markdown.*absolute file path.*<\/runtime_info>$/,
    );
    NodeAssert.doesNotMatch(instructions, /\n/);
  });

  it("leaves the harness, model and effort out, as the harness's own app does", () => {
    const first = runtimeInstructions({ model: "gpt-5.3-codex", reasoningEffort: "medium" });
    const second = runtimeInstructions({ model: "gpt-5.4", reasoningEffort: "high" });
    NodeAssert.equal(first, second);
    NodeAssert.doesNotMatch(first, /SSHCode|Codex harness|gpt-5|reasoning effort/);
  });
});

describe("T3 browser developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools in both collaboration modes", () => {
    {
      const instructions = toolInstructions(runtime, true);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = toolInstructions(runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /SSHCode collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(buildCodexDeveloperInstructions(mode), /<collaboration_mode>/);
      NodeAssert.match(buildCodexDeveloperInstructions(mode), /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(toolInstructions(runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(toolInstructions(runtime, false), /preview_open/);
  });
});

describe("Codex browser context", () => {
  it("rules out the ChatGPT app's browser and names the default browser", () => {
    const context = buildCodexBrowserContext({ name: "Aside", bundleId: "at.studio.AsideBrowser" });
    const text = context.t3_code_browser!.value;
    NodeAssert.equal(context.t3_code_browser!.kind, "application");
    NodeAssert.match(text, /`iab` backend\) belongs to that app and isn't available here/);
    NodeAssert.match(
      text,
      /their default browser, Aside: `await cua\.getApp\("at\.studio\.AsideBrowser"\)`/,
    );
  });

  it("still steers Codex away from the in-app browser when the default browser is unknown", () => {
    const text = buildCodexBrowserContext(null).t3_code_browser!.value;
    NodeAssert.match(text, /don't look for it/);
    NodeAssert.match(text, /their default browser app with `cua\.getApp\(\.\.\.\)`/);
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}
function toolInstructions(
  runtime: Parameters<typeof buildCodexAdditionalContext>[0],
  available: boolean,
) {
  return buildCodexAdditionalContext(runtime, available).t3_code_tools?.value ?? "";
}
