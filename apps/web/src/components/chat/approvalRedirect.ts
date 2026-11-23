import type { RuntimeRequestId } from "@t3tools/contracts";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import type { PendingApproval } from "../../session-logic";

const fileIdentities = new WeakMap<File, number>();
let nextFileIdentity = 0;
function fileIdentity(file: File | null) {
  if (file === null) return null;
  let id = fileIdentities.get(file);
  if (id === undefined) {
    id = ++nextFileIdentity;
    fileIdentities.set(file, id);
  }
  return id;
}

/** Compare user-owned draft content while ignoring upload progress and other ambient settings. */
export function approvalRedirectDraftFingerprint(draft: ComposerThreadDraftState | null): string {
  return JSON.stringify({
    prompt: draft?.prompt ?? "",
    images:
      draft?.images.map((image) => [
        image.id,
        image.name,
        image.mimeType,
        image.sizeBytes,
        fileIdentity(image.file),
        image.source,
      ]) ?? [],
    files:
      draft?.files.map((file) => [
        file.id,
        file.name,
        file.mimeType,
        file.sizeBytes,
        fileIdentity(file.file),
        file.source,
      ]) ?? [],
    terminalContexts: draft?.terminalContexts ?? [],
    reviewComments: draft?.reviewComments ?? [],
    previewAnnotations: draft?.previewAnnotations ?? [],
    threadContexts: draft?.threadContexts ?? [],
  });
}

function canDeclineApproval(approval: PendingApproval): boolean {
  return (
    approval.responseCapability === "live" &&
    (approval.options === undefined ||
      approval.options.some((option) => option.decision === "decline"))
  );
}

/** Keep question flows and queued edits distinct from an approval redirect. */
export function composerApprovalState(input: {
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly approvalShown: boolean;
  readonly hasQuestion: boolean;
  readonly editingQueuedMessage: boolean;
}) {
  return {
    editorBlocked: input.approvalShown && input.hasQuestion,
    redirectsOnSend:
      input.approvals.length > 0 && !input.hasQuestion && !input.editingQueuedMessage,
    canDecline: input.approvals.every(canDeclineApproval),
  };
}

interface RedirectState {
  readonly threadKey: string | null;
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly responding: ReadonlyArray<RuntimeRequestId>;
  readonly blockingRequest: boolean;
  readonly draftFingerprint: string;
  readonly pendingDraftWork: boolean;
}

type RedirectResult = "ready" | "approval-failed" | "changed" | "blocked";

/** Decline only approvals present when Send was pressed; recheck state around every await. */
export async function prepareApprovalRedirect(input: {
  readonly threadKey: string;
  readonly approvalIds: ReadonlyArray<RuntimeRequestId>;
  readonly draftFingerprint: string;
  readonly readState: () => RedirectState;
  readonly respond: (id: RuntimeRequestId) => Promise<{ readonly _tag: string } | undefined>;
}): Promise<RedirectResult> {
  const originalIds = new Set(input.approvalIds);
  const check = (): RedirectResult => {
    const state = input.readState();
    if (state.threadKey !== input.threadKey || state.blockingRequest) return "blocked";
    if (state.approvals.some((approval) => !originalIds.has(approval.requestId))) return "changed";
    if (state.pendingDraftWork || state.draftFingerprint !== input.draftFingerprint)
      return "changed";
    if (state.approvals.some((approval) => state.responding.includes(approval.requestId)))
      return "blocked";
    if (state.approvals.some((approval) => !canDeclineApproval(approval))) return "approval-failed";
    return "ready";
  };
  if (input.approvalIds.length === 0) {
    const state = input.readState();
    return state.threadKey !== input.threadKey || state.blockingRequest
      ? "blocked"
      : state.approvals.length > 0 ||
          state.pendingDraftWork ||
          state.draftFingerprint !== input.draftFingerprint
        ? "changed"
        : "ready";
  }
  let status = check();
  if (status !== "ready") return status;
  for (const id of input.approvalIds) {
    if (!input.readState().approvals.some((approval) => approval.requestId === id)) continue;
    try {
      if ((await input.respond(id))?._tag !== "Success") return "approval-failed";
    } catch {
      return "approval-failed";
    }
    status = check();
    if (status !== "ready") return status;
  }
  return "ready";
}
