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
    "Lease computer control and open appId from computer_status. Busy requests may queue; respect user takeover.",
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
    "Read app accessibility text with native refs (no screenshot). Pass snapshotId as since for a patch; raise maxChars only if truncated.",
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
    "Click, type, press or scroll in your leased app. Prefer snapshot refs; clickAt needs screenshot captureId. Background delivery by default; verify with a snapshot.",
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
  description: "Release your computer lease when done (leaves app open).",
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
    "Capture your leased app as PNG with captureId for coordinate clicks. Prefer text snapshots for routine checks.",
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
