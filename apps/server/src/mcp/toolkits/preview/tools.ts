import {
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationActInput,
  PreviewAutomationDialogInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewObservationOptions,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as QaSandbox from "../../../preview/QaSandbox.ts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
  QaSandbox.QaSandbox,
];

/** What a browser action fails with, including the access gate's refusal. */
const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

// What an action changed on an observed tab (see BrowserObservations). Kept
// loose here: its full shape would be advertised to every agent session.
const PreviewActPageChange = Schema.Record(Schema.String, Schema.Unknown);

const actFields = { ...presentationFields, page: Schema.optional(PreviewActPageChange) };

const PreviewActResult = Schema.Struct(actFields).annotate({
  description: "The preview action completed successfully.",
});

/** Drives the real browser and can destroy page state. */
const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

/** Same open-world browser access, but the action does not destroy page state. */
const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

/** A safe browser action that only observes, so it is also repeatable. */
const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const QaSandboxTool = Tool.make("qa_sandbox", {
  description:
    "SSHCode UI checks: start (or reuse) an isolated copy of this checkout's app with fake models and a background tab; stop removes it; status lists yours. Idles out after 30m.",
  parameters: QaSandbox.QaSandboxInput,
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "QA sandbox")
  .annotate(Tool.Destructive, false);

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Show browser tabs, owners, dialogs, automation, loading and viewport. Server hosts include all thread tabs and profiles. Read any listed tab. Act on your own or unclaimed tabs with no human in control.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Open a collaborative tab. Parallel subagents sharing a session each set reuseExistingTab=false and use their tabId on every call. Other sessions' tabs are read-only. For standalone charts use html_preview then html_render when available.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss a browser dialog from preview_status. Pass promptText for prompts; needs tab ownership or unclaimed tab.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a tab. Pass exactly one of url for a website or target like {kind:'environment-port',port:5173} for a dev server.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a tab with {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. Changes layout with the desktop user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description: "Set a tab's prefers-color-scheme to light or dark. system clears the override.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a semantic tree. Act with locator='aria-ref=<ref>', including in frames. since=snapshotId returns a diff. Apply patches last to first, replacing deleteCount lines at zero-based fromLine. Expired baselines give a full tree. Refresh after navigation or human takeover. Embed saved screenshotPath as ![alt](path).",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      ...PreviewObservationOptions.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description: "Include a PNG in the response only for visual inspection. Default false.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Save a PNG and return its absolute screenshotPath; unless includeImage=true, return only url and screenshotPath. Default false.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewActTool = browserTool(
  Tool.make("preview_act", {
    description:
      "Act on a tab. Use locator='aria-ref=<ref>' from preview_snapshot or paired x/y. click uses button/clickCount (1–3). type sends text. clear=true replaces. select uses values in a native select. Click custom options. drag uses source/target. upload passes absolute paths to a reported picker ([] cancels) or targets a file input by locator. press sends key/modifiers to the focused element. scroll uses deltaY/deltaX (positive down/right) and optional locator. page patches the last snapshot automatically.",
    parameters: PreviewAutomationActInput,
    success: Schema.Union([
      Schema.Struct({ ...PreviewAutomationSelectResult.fields, ...actFields }),
      PreviewActResult,
    ]),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Act in preview page"),
);

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
}).annotate({ description: "The evaluated expression result." });

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Run JavaScript in a preview tab and return {value}. JSON-serializable up to 64 KB; may mutate page. Needs tab ownership or unclaimed tab; use preview_snapshot for user-driven tabs.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait for preview tab conditions. Matches all supplied locator, selector, text, and URL checks on tabId or your current tab.",
    parameters: PreviewAutomationWaitForInput,
    success: Schema.Struct({ ...presentationFields, notice: Schema.optional(Schema.String) }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording a collaborative browser tab (tabId or current tab).",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording a preview tab and save it locally. Transfers the compressed recording (up to 50 MiB) and returns its path.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  QaSandboxTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewActTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  QaSandboxTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewActTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
