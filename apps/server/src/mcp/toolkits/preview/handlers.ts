import * as QaSandbox from "../../../preview/QaSandbox.ts";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationActInputs,
  PreviewAutomationInvalidSelectorError,
  type PreviewAutomationActInput,
  OrchestratorMcpFailure,
  type ToolActivityIcon,
  type ThreadId,
  type PreviewAutomationOperation,
  type PreviewAutomationWaitForInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";

import {
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { captureCallerSteer, raceWithSteer, STEER_NOTICE } from "../../McpSteerWait.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as BrowserObservations from "../../../preview/BrowserObservations.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/**
 * Collapses the `show` alias onto `open` and defaults tab reuse.
 *
 * Deliberately leaves an unstated `open` unstated. Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  { result: A; toolIcon?: ToolActivityIcon },
  import("@t3tools/contracts").PreviewAutomationError,
  | McpInvocationContext.McpInvocationContext
  | PreviewAutomationBroker.PreviewAutomationBroker
  | QaSandbox.QaSandbox
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const qa = yield* QaSandbox.QaSandbox;
  yield* qa.touch(scope);
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  let targetTabId = tabId;
  const result = yield* broker.invoke<A>({
    onTargetTab: (resolvedTabId) => {
      targetTabId = resolvedTabId;
    },
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
  if (operation === "snapshot" && typeof result === "object" && result !== null) {
    return { result: { ...result, ...(targetTabId === undefined ? {} : { tabId: targetTabId }) } };
  }
  if (["status", "open", "navigate"].includes(operation)) return { result };
  const statusTabId =
    (operation !== "evaluate" && typeof result === "object" && result !== null
      ? (result as { tabId?: PreviewTabId }).tabId
      : undefined) ?? targetTabId;
  const page = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      timeoutMs: 500,
      updateCurrentTab: false,
      ...(statusTabId === undefined ? {} : { tabId: statusTabId }),
    })
    .pipe(Effect.orElseSucceed(() => null));
  return {
    result,
    ...(page?.url && /^https?:\/\//i.test(page.url) && page.url.length <= 4096
      ? { toolIcon: { _tag: "website" as const, pageUrl: page.url } }
      : {}),
  };
});

const invokeTargeted = <A extends object>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId).pipe(
    Effect.map(({ result, toolIcon }) => ({
      ...result,
      ...(toolIcon ? { toolIcon } : {}),
    })),
  );
};

export const waitForPreview = Effect.fn("PreviewToolkit.waitFor")(function* (
  input: PreviewAutomationWaitForInput,
) {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const steer = yield* captureCallerSteer(scope);
  const result = yield* raceWithSteer(
    invokeTargeted<object>("waitFor", input, input.timeoutMs),
    steer,
  );
  return Option.isSome(result) ? result.value : { notice: STEER_NOTICE };
});

const decodeActInput = Record.map(PreviewAutomationActInputs, (schema) =>
  Schema.decodeUnknownEffect(schema),
);

const runPreviewAct = ({ action, ...input }: PreviewAutomationActInput) =>
  decodeActInput[action](input).pipe(
    Effect.mapError(
      (cause) => new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
    ),
    Effect.flatMap((decoded) =>
      invokeTargeted<object>(
        action,
        decoded,
        "timeoutMs" in decoded ? decoded.timeoutMs : undefined,
      ),
    ),
  );

const UploadedRecordingArtifact = Schema.Struct({
  ...PreviewAutomationRecordingArtifact.fields,
  uploadedAttachmentId: Schema.optional(Schema.String),
});
const decodeUploadedRecordingArtifact = Schema.decodeUnknownEffect(UploadedRecordingArtifact);

export const claimPreviewRecording = Effect.fn("PreviewToolkit.claimRecording")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const artifact = yield* decodeUploadedRecordingArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  );
  if (!artifact.uploadedAttachmentId) {
    return yield* new PreviewAutomationRecordingDesktopUpdateRequiredError({ threadId });
  }
  const config = yield* ServerConfig.ServerConfig;
  const uuid = parseAttachmentUuid(artifact.uploadedAttachmentId);
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
  if (!uuid || !extension || !threadSegment || artifact.uploadedAttachmentId !== pendingId) {
    return yield* new PreviewAutomationRecordingTransferError({
      threadId,
    });
  }
  // The same completed upload can be returned to overlapping stop requests.
  const finalId = `${threadSegment}-${uuid}-${extension}`;
  const currentPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${pendingId}.${extension}`,
  });
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${finalId}.${extension}`,
  });
  if (!currentPath || !finalPath) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const validateFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.filterOrFail(
        (stat) =>
          stat.type === "File" &&
          Number(stat.size) === artifact.sizeBytes &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        () => new PreviewAutomationRecordingTransferError({ threadId }),
      ),
    );
  yield* Effect.gen(function* () {
    yield* validateFile(currentPath);
    yield* fileSystem.rename(currentPath, finalPath);
  }).pipe(
    // Another stop may already have claimed this exact upload for this thread.
    Effect.catchIf(
      (cause) =>
        cause._tag !== "PreviewAutomationRecordingTransferError" &&
        cause.reason._tag === "NotFound",
      () => validateFile(finalPath),
    ),
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  );
  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact;
  return { ...recording, id: finalId, path: finalPath };
});

const handlers = {
  qa_sandbox: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      return yield* (yield* QaSandbox.QaSandbox).run(scope, input);
    }),
  ),
  preview_dialog: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("dialog", input),
  ),
  preview_status: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  ),
  preview_open: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  ),
  preview_resize: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  ),
  preview_set_appearance: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  ),
  preview_snapshot: McpToolAccess.readsAsCaller((input) => {
    const { includeImage, save, ...operationInput } = input ?? {};
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", {
      ...operationInput,
      captureScreenshot: includeImage === true || save === true,
    });
  }),
  preview_act: McpToolAccess.actsAsCaller(runPreviewAct),
  preview_evaluate: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    invoke<unknown>("evaluate", input, undefined, tabId).pipe(
      Effect.map(({ result, toolIcon }) => ({
        value: result ?? null,
        ...(toolIcon ? { toolIcon } : {}),
      })),
    ),
  ),
  preview_wait_for: McpToolAccess.readsAsCaller(waitForPreview),
  preview_recording_start: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  ),
  preview_recording_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...operationInput, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewRecording(scope.thread.threadId, response.result);
      return { ...artifact, ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PreviewToolkit.tools>;

const { preview_snapshot, ...standardHandlers } = handlers;

// Long enough for a settled page, short enough not to hold an action's reply.
const ACTION_CHANGE_SNAPSHOT_TIMEOUT_MS = 2_000;

const recoverStaleRef = (
  observations: BrowserObservations.BrowserObservations["Service"],
  error: PreviewAutomationInvalidSelectorError,
) =>
  Effect.gen(function* () {
    if (!error.staleRef) return yield* error;
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const page = yield* invoke<PreviewAutomationSnapshot>(
      "snapshot",
      { captureScreenshot: false, mode: "compact" },
      ACTION_CHANGE_SNAPSHOT_TIMEOUT_MS,
      error.tabId,
    ).pipe(
      Effect.flatMap(({ result: snapshot }) =>
        observations.observe(invocation.requestNamespace, snapshot, {
          mode: "compact",
          maxChars: 3_000,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    return yield* new PreviewAutomationInvalidSelectorError({
      ...error,
      // Error.cause is non-enumerable, but the failure schema requires it.
      cause: error.cause,
      ...(page === undefined ? {} : { page: { ...page } }),
    });
  });

/**
 * preview_act, plus what the action changed on a tab the caller has observed,
 * so an agent doesn't spend a turn on a snapshot after every click.
 */
const previewActWithPageChange = (
  observations: BrowserObservations.BrowserObservations["Service"],
) =>
  McpToolAccess.actsAsCaller((payload: PreviewAutomationActInput) =>
    Effect.gen(function* () {
      const result = yield* runPreviewAct(payload).pipe(
        Effect.catchTags({
          PreviewAutomationInvalidSelectorError: (error) => recoverStaleRef(observations, error),
        }),
      );
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const page = yield* invoke<PreviewAutomationSnapshot>(
        "snapshot",
        { captureScreenshot: false },
        ACTION_CHANGE_SNAPSHOT_TIMEOUT_MS,
        payload.tabId,
      ).pipe(
        Effect.flatMap(({ result: snapshot }) =>
          observations.observeActionChange(invocation.requestNamespace, snapshot),
        ),
        // The action already succeeded; a page that can't be read leaves it unreported.
        Effect.orElseSucceed(() => undefined),
      );
      return page === undefined ? result : { ...result, page };
    }),
  );

export const layerStandard = McpToolAccess.toLayer(
  PreviewStandardToolkit,
  Effect.gen(function* () {
    const observations = yield* BrowserObservations.BrowserObservations;
    return {
      ...standardHandlers,
      preview_act: previewActWithPageChange(observations),
      preview_wait_for: McpToolAccess.readsAsCaller((input) =>
        waitForPreview(input).pipe(
          Effect.catchTags({
            PreviewAutomationInvalidSelectorError: (error) => recoverStaleRef(observations, error),
          }),
        ),
      ),
    };
  }),
);

export const layerSnapshot = McpToolAccess.toLayer(PreviewSnapshotToolkit, {
  preview_snapshot,
});
