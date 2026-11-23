import { ComputerAction, ComputerUseError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUseService from "../../../computer/ComputerUseService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  ComputerUseService.ComputerUseService,
  ThreadManagementService.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
];
const failure = Schema.Union([ComputerUseError, OrchestratorMcpFailure]);
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Lease = { leaseId: Id };

const status = Tool.make("computer_status", {
  description:
    "Check computer access, current controller and waiting agents. includeApps lists available app ids when access is enabled. Use device_list/device_open for simulators.",
  parameters: Schema.Struct({ includeApps: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.Unknown,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Computer status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const open = Tool.make("computer_open", {
  description:
    "Acquire computer control and open an app by id from computer_status. Returns a lease and short operating instructions. Busy requests may queue; inspect status and retry when control is available. Respect other controllers and user takeover.",
  parameters: Schema.Struct({ appId: Id }),
  success: Schema.Unknown,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Open computer app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const snapshot = Tool.make("computer_snapshot", {
  description:
    "Inspect your app as compact accessibility text with native control refs. Reuse snapshotId as since for a small patch or unchanged. No screenshot is taken. Increase maxChars only if truncation hides the target.",
  parameters: Schema.Struct({
    ...Lease,
    maxChars: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 20_000 })),
    ),
    since: Schema.optionalKey(Id),
  }),
  success: Schema.Unknown,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Inspect computer app")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const action = Tool.make("computer_action", {
  description:
    "Click, type, press a key or scroll in your leased app. Prefer fresh snapshot refs. clickAt requires a screenshot captureId. Background delivery is default; choose foreground explicitly when the app needs it. Verify the result with a compact snapshot.",
  parameters: Schema.Struct({ ...Lease, action: ComputerAction }),
  success: Schema.Unknown,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Control computer app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const release = Tool.make("computer_release", {
  description:
    "Release your computer lease after finishing, so the next waiting agent can work. This leaves the app open.",
  parameters: Schema.Struct(Lease),
  success: Schema.Struct({ released: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Release computer control")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "Capture an image of your leased app when visual inspection is needed. Returns image content plus captureId for grounded coordinate clicks. Prefer text snapshots for routine inspection.",
  parameters: Schema.Struct(Lease),
  success: Schema.Struct({
    screenshot: Schema.Struct({
      mimeType: Schema.Literals(["image/png", "image/jpeg"]),
      data: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
    captureId: Schema.optionalKey(Schema.String),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot computer app")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerStandardToolkit = Toolkit.make(status, open, snapshot, action, release);
export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
export const ComputerToolkit = Toolkit.make(
  status,
  open,
  snapshot,
  action,
  release,
  ComputerScreenshotTool,
);
