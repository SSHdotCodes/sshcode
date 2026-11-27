import type { ProviderInteractionMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  botInstructionsFor,
  orchestrationInstructionsFor,
} from "@t3tools/provider-core/server/orchestrationInstructions";

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## SSHCode devices

The \`t3-code\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, using the exact launcher path returned by \`device_open\`. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Prefer these tools and \`agent-device\` for opening and driving devices. Platform tools such as \`xcrun simctl\` and \`adb\` remain available for anything they do not cover, such as builds, logs, or port forwarding. If \`device_list\` reports a platform as unavailable, say so.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/**
 * Each block is omitted entirely when its tools aren't attached. Describing
 * `preview_*` or `device_*` tools that aren't in the turn's tool list would be
 * worse than saying nothing: the instructions actively steer the model away
 * from Playwright, agent-browser, and raw simctl/adb, so leaving them in would
 * talk it out of the only automation it still has.
 */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** The Mac's default web browser, which Codex's Computer Use can drive. */
export interface CodexHostBrowser {
  readonly name: string;
  readonly bundleId: string;
}

const hostCommandOutput = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
      .pipe(Effect.timeout("5 seconds"));
  });

const decodeLaunchServicesHandlers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        LSHandlerURLScheme: Schema.optional(Schema.String),
        LSHandlerRoleAll: Schema.optional(Schema.String),
      }),
    ),
  ),
);

/** Codex's Computer Use plugin, as the ChatGPT app enables it in `config.toml`. */
const COMPUTER_USE_ENABLED =
  /^\[plugins\."(?:unified-)?computer-use@openai-bundled"\]\s*\n\s*enabled\s*=\s*true\b/mu;
const BUNDLE_ID = /^[\w.-]+$/u;

/**
 * The default https handler from LaunchServices, when the Codex home at
 * `codexHome` has Computer Use. `undefined` without it (and off macOS);
 * `null` when the browser can't be identified.
 */
export const loadCodexHostBrowser = (
  codexHome: string,
): Effect.Effect<
  CodexHostBrowser | null | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* fileSystem.readFileString(`${codexHome}/config.toml`);
    if (!COMPUTER_USE_ENABLED.test(config)) return undefined;
    const handlers = yield* decodeLaunchServicesHandlers(
      yield* hostCommandOutput("/usr/bin/plutil", [
        "-extract",
        "LSHandlers",
        "json",
        "-o",
        "-",
        `${yield* HostProcess.HomeDirectory}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`,
      ]),
    );
    const handler = handlers.find((entry) => entry.LSHandlerURLScheme === "https");
    // With no https handler set, macOS opens links in Safari.
    if (handler === undefined) return { name: "Safari", bundleId: "com.apple.Safari" };
    const handlerId = handler.LSHandlerRoleAll;
    if (handlerId === undefined || !BUNDLE_ID.test(handlerId)) return null;
    // LaunchServices lowercases the id; the app's own Info.plist has the exact one.
    const appPath = (yield* hostCommandOutput("/usr/bin/mdfind", [
      `kMDItemCFBundleIdentifier == '${handlerId}'c`,
    ]))
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".app"));
    if (appPath === undefined) return null;
    const read = (key: string) =>
      hostCommandOutput("/usr/bin/plutil", [
        "-extract",
        key,
        "raw",
        "-o",
        "-",
        `${appPath}/Contents/Info.plist`,
      ]).pipe(
        Effect.map((value) => value.trim()),
        Effect.orElseSucceed(() => ""),
      );
    const bundleId = yield* read("CFBundleIdentifier");
    const name = (yield* read("CFBundleDisplayName")) || (yield* read("CFBundleName"));
    return BUNDLE_ID.test(bundleId) && name ? { name, bundleId } : null;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Codex's Computer Use looks for the ChatGPT desktop app's in-app browser first,
 * which only exists for chats that app runs. Here the lookup comes back empty
 * after up to a minute, so point Codex at the user's own browser instead.
 */
export function buildCodexBrowserContext(
  browser: CodexHostBrowser | null,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const target = browser
    ? `their default browser, ${browser.name}: \`await cua.getApp("${browser.bundleId}")\``
    : "their default browser app with `cua.getApp(...)`";
  return {
    t3_code_browser: {
      kind: "application",
      value: `## Browser in SSHCode

This chat runs in SSHCode, not the ChatGPT desktop app. Codex's in-app browser (\`@Browser\`, the \`iab\` backend) belongs to that app and isn't available here, so don't look for it: \`cua.getState()\` and \`cua.listBrowsers()\` can't return it here and can take a minute to answer.

Fetch public pages directly. For a site that needs the user's sign-ins, or when they ask about their browser, use Computer Use (\`cua_repl\`) on ${target}, and open a new tab for your task rather than changing the one they're on.`,
    },
  };
}

const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

Remain in Plan Mode until a developer message explicitly ends it. User requests to execute mean plan the execution. The \`update_plan\` checklist tool neither changes this mode nor works in it; do not call it.

Explore with non-mutating, plan-improving actions. Read/search repo files, configs, schemas and docs; inspect and analyze; run dry runs, tests, builds or checks that write only caches/build artifacts, never tracked files. Do not implement: no file edits, rewriting formatters/linters, migrations, patches, codegen or side effects that carry out the plan. When unsure, ask whether the action gathers facts or does the work.

Work through three phases conversationally:
1. Ground in the environment. Resolve discoverable repo/system facts with targeted searches and inspection before asking. Do at least one exploration pass unless no local environment exists or the prompt itself has obvious ambiguities/contradictions. Silent exploration between turns is fine. Exhaust reasonable discovery; if an identifier remains ambiguous, present concrete candidates and recommend one.
2. Clarify intent: goal, success criteria, audience, scope, constraints, current state and preferences/tradeoffs. Ask early about high-impact ambiguities instead of guessing.
3. Make implementation decision complete: approach, interfaces, data flow, failure modes, tests/acceptance, rollout/monitoring and migrations/compatibility. The engineer or agent receiving the plan should need no further decisions.

Prefer \`request_user_input\` for questions that materially change the plan, lock important assumptions or resolve undiscoverable information. Offer 2-4 meaningful, mutually exclusive options with a recommended default; no filler. Ask directly only for unavoidable important questions that cannot fit choices. If a preference is unanswered, use and record the default.

Finalize only a complete spec, with at most one block per turn. Keep these exact tags on their own lines, content starting on the next line, in every language:
<proposed_plan>
Markdown plan
</proposed_plan>

The final plan is plan-only and concise by default: title, summary, key changes (including public interfaces), test cases and explicit assumptions/defaults, usually 3-5 short sections. Group by behavior/subsystem; name files only to disambiguate, usually at most 3 paths. Omit redundant facts, exhaustive branches and invented v1 policy unless needed to prevent a concrete mistake. Use short bullets without nested explanations and no separate Scope section unless necessary. Prefer the minimum detail for safe implementation; omit unrelated workflow states. Expand when asked. Do not ask whether to proceed: the user can switch modes.

Revisions replace the entire block. If objections lack enough detail, clarify before issuing a replacement. For a follow-up that neither changes nor challenges the plan, answer then reproduce the prior block unchanged.
</collaboration_mode>`;

const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

Use the \`request_user_input\` tool only when it is listed in the available tools for this turn.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort: string;
}

/** Mode prompt for `turn/start.collaborationMode.settings.developer_instructions`. */
export function buildCodexDeveloperInstructions(interactionMode: ProviderInteractionMode): string {
  return interactionMode === "plan"
    ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
    : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS;
}

/**
 * SSHCode context for `turn/start.additionalContext`. Codex renders each entry
 * as a `<key>value</key>` developer message and resends it only when the value
 * changes.
 *
 * This must stay out of the collaboration mode: when the model catalog ships
 * its own text for a mode, as newer models do, Codex uses that text and drops
 * the client's `developer_instructions` entirely.
 */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  /**
   * Whether the `t3-code` MCP server is attached to this turn. Callers derive
   * it from the session's actual MCP configuration rather than re-reading the
   * setting, so the prompt cannot claim tools the turn doesn't have.
   */
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  threadId?: string,
  subagentsEnabled?: (threadId: string | undefined) => boolean,
  isSubagent?: boolean,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Its own entry, so a memory edit resends this block alone.
  const bot = isSubagent ? null : botInstructionsFor(threadId);
  // Separate keys keep each value under Codex's per-entry token cap.
  return {
    t3_code_orchestration: {
      kind: "application",
      value: orchestrationInstructionsFor(threadId, subagentsEnabled, isSubagent, false),
    },
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
    ...(bot === null ? {} : { t3_code_bot: { kind: "application", value: bot } }),
  };
}
