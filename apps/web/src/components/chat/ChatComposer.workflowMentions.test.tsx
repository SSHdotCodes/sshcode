// @vitest-environment jsdom
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ThreadId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const workflows = vi.hoisted(() => {
  let list: ReadonlyArray<unknown> = [];
  const listeners = new Set<() => void>();
  return {
    read: () => list,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The server's list arrives. */
    load: (next: ReadonlyArray<unknown>) => {
      list = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../workflows/workflowsBeta", () => ({ useWorkflowsBeta: () => true }));
vi.mock("../workflows/useWorkflows", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("../workflows/useWorkflows")>()),
    useWorkflowsState: () => ({
      state: {
        version: 1,
        workflows: useSyncExternalStore(workflows.subscribe, workflows.read),
        runs: [],
      },
      loading: false,
      error: null,
      canEdit: true,
    }),
  };
});

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

const environmentId = EnvironmentId.make("local");
const draftId = DraftId.make("new-chat");
const deploy: WorkflowDefinition = {
  version: 1,
  id: "deploy" as WorkflowDefinition["id"],
  name: "Deploy review",
  description: "",
  rootNodeId: null,
  nodes: [],
  edges: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const noop = () => {};
const props: ChatComposerProps = {
  composerDraftTarget: draftId,
  environmentId,
  canOperateThread: true,
  attachmentUploadsCapabilityKnown: true,
  supportsAttachmentUploads: true,
  supportsQuestionAttachments: false,
  maxFileAttachmentBytes: null,
  routeKind: "draft",
  routeThreadRef: { environmentId, threadId: ThreadId.make("new-chat") },
  draftId,
  multipleModelSelections: null,
  supportsMultipleModels: false,
  onMultipleModelSelectionsChange: noop,
  activeThreadId: null,
  activeThreadEnvironmentId: undefined,
  threadStarted: false,
  hasThreadShell: false,
  threadShellStarted: false,
  threadTitle: undefined,
  threadSubagentsEnabled: undefined,
  runtimeProviderInstanceId: undefined,
  runtimeActiveRunId: null,
  hasEarlierPrompts: false,
  hasTimelineEntries: false,
  readPromptHistoryMessages: () => [],
  isServerThread: false,
  isLocalDraftThread: true,
  forceExpandedOnMobile: false,
  projectSelectionRequired: false,
  phase: "ready",
  followUpRunning: false,
  canInterrupt: false,
  canSteer: false,
  isConnecting: false,
  isSendBusy: false,
  canResume: false,
  sendDisabledReason: null,
  isPreparingWorktree: false,
  isCompacting: false,
  bannerItems: [],
  environmentUnavailable: null,
  activePendingApproval: null,
  pendingApprovals: [],
  pendingUserInputs: [],
  activePendingProgress: null,
  activePendingResolvedAnswers: null,
  activePendingIsResponding: false,
  activePendingDraftAnswers: {},
  activePendingQuestionIndex: 0,
  respondingRequestIds: [],
  showPlanFollowUpPrompt: false,
  activeProposedPlan: null,
  activeTasksProgress: null,
  activeTaskSteps: null,
  threadSyncPhase: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  lockedProvider: null,
  providerStatuses: [],
  providerCatalogKnown: true,
  activeProjectDefaultModelSelection: null,
  activeThreadModelSelection: null,
  activeProjectId: null,
  activeContextWindow: null,
  compactThreadUnavailable: true,
  compactDisabled: true,
  compactDisabledReason: null,
  resolvedTheme: "light",
  settings: DEFAULT_UNIFIED_SETTINGS,
  keybindings: [],
  terminalOpen: false,
  gitCwd: null,
  pullRequestProjectId: null,
  pullRequestRepository: null,
  threadPullRequests: undefined,
  restingControlsHost: null,
  restingControlsHaveLeadingContext: false,
  onRestingControlsVisibilityChange: noop,
  getTimelineScrollableNode: () => null,
  isTimelineAtLogicalEnd: () => true,
  timelineOverflows: false,
  onComposerOverlayHeightChange: noop,
  onRestingChange: noop,
  promptRef: { current: "" },
  composerImagesRef: { current: [] },
  composerFilesRef: { current: [] },
  composerTerminalContextsRef: { current: [] },
  composerRef: createRef(),
  onPageScrollKeyDown: noop,
  onPageScrollKeyUp: noop,
  onPageScrollRelease: noop,
  editingQueuedAttachments: null,
  onRemoveEditingQueuedAttachment: noop,
  onCompactContext: noop,
  onSend: noop,
  onScheduleMessage: async () => {},
  onManageScheduledMessages: noop,
  canScheduleMessage: false,
  scheduleUnavailableReason: null,
  onResume: noop,
  onInterrupt: noop,
  onImplementPlanInNewThread: noop,
  onRespondToApproval: async () => undefined,
  onSelectActivePendingUserInputOption: noop,
  onAdvanceActivePendingUserInput: noop,
  onDismissActivePendingUserInput: noop,
  onPreviousActivePendingUserInputQuestion: noop,
  onChangeActivePendingUserInputCustomAnswer: noop,
  onProviderModelSelect: noop,
  onOpenProviderSetup: noop,
  getModelDisabledReason: () => null,
  toggleInteractionMode: noop,
  handleRuntimeModeChange: noop,
  handleInteractionModeChange: noop,
  focusComposer: noop,
  scheduleComposerFocus: noop,
  setThreadError: noop,
  onExpandImage: noop,
  onFileOpen: noop,
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom has no font loading API; the composer listens for late font loads.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {} },
  });
  // jsdom does no layout or animation; the menu scrolls its highlighted row into view and its
  // scroll area asks for running animations.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  workflows.load([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(document, "fonts");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

it("offers a workflow in the @ menu as soon as the workflows load", async () => {
  useComposerDraftStore.getState().setPrompt(draftId, "@deploy");
  await act(async () => root.render(<ChatComposer {...props} />));
  const editor = () => host.querySelector('[role="textbox"][aria-label="Message"]');
  expect(editor()).not.toBeNull();
  // Nothing matches yet, so the editor points at no suggestion.
  expect(editor()?.getAttribute("aria-activedescendant")).toBeNull();

  // The list arrives while "@deploy" is still what is typed: no further keystroke.
  await act(async () => workflows.load([deploy]));

  expect(editor()?.getAttribute("aria-activedescendant") ?? "").toContain("workflow%3Adeploy");
  expect(document.body.textContent).toContain("Deploy review");
});
