import { makeThreadProjectionFixture } from "../../test-fixtures";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { TurnItemId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  approvalRedirectDraftFingerprint,
  composerApprovalState,
  prepareApprovalRedirect,
} from "./approvalRedirect";
import { createEmptyThreadDraft } from "../../composerDraftStore";
import type { PendingApproval } from "../../session-logic";

const approval = (id: string): PendingApproval => ({
  requestId: RuntimeRequestId.make(id),
  requestKind: "command",
  createdAt: "2026-01-01T00:00:00Z",
  responseCapability: "live",
});
const a = approval("a");
const b = approval("b");
function setup() {
  const state = {
    threadKey: "env:thread" as string | null,
    approvals: [a, b] as PendingApproval[],
    responding: [] as RuntimeRequestId[],
    blockingRequest: false,
    draftFingerprint: "draft-with-attachments",
    pendingDraftWork: false,
  };
  const respond = vi.fn(async (_id: RuntimeRequestId): Promise<{ _tag: string } | undefined> => ({
    _tag: "Success",
  }));
  const run = () =>
    prepareApprovalRedirect({
      threadKey: "env:thread",
      approvalIds: [a.requestId, b.requestId],
      draftFingerprint: "draft-with-attachments",
      readState: () => state,
      respond,
    });
  return { state, respond, run };
}

describe("approval redirect", () => {
  it("keeps the editor usable with visible or held approvals and preserves other request flows", () => {
    const input = {
      approvals: [a],
      approvalShown: true,
      hasQuestion: false,
      editingQueuedMessage: false,
    };
    expect(composerApprovalState(input)).toEqual({
      editorBlocked: false,
      redirectsOnSend: true,
      canDecline: true,
    });
    expect(composerApprovalState({ ...input, approvalShown: false }).redirectsOnSend).toBe(true);
    expect(composerApprovalState({ ...input, hasQuestion: true })).toMatchObject({
      editorBlocked: true,
      redirectsOnSend: false,
    });
    expect(composerApprovalState({ ...input, editingQueuedMessage: true }).redirectsOnSend).toBe(
      false,
    );
  });
  it("allows a normal send while a secret card is pending", async () => {
    const base = makeThreadProjectionFixture();
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      turnItems: [
        {
          id: TurnItemId.make("secret"),
          threadId: base.thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          title: "API key",
          startedAt: null,
          completedAt: null,
          updatedAt: base.updatedAt,
          type: "secret_request",
          secretStatus: "pending",
          status: "waiting",
          label: "API key",
          reason: "Needed later",
        },
      ],
    };
    const pending = derivePendingThreadRequests(projection);
    const approvalState = composerApprovalState({
      approvals: [],
      approvalShown: false,
      hasQuestion: pending.userInputs.length > 0,
      editingQueuedMessage: false,
    });
    expect(approvalState.editorBlocked).toBe(false);
    expect(approvalState.redirectsOnSend).toBe(false);
    const { state, respond } = setup();
    state.approvals = [];
    state.blockingRequest = pending.userInputs.length > 0;
    const send = vi.fn();
    if (
      (await prepareApprovalRedirect({
        threadKey: "env:thread",
        approvalIds: [],
        draftFingerprint: state.draftFingerprint,
        readState: () => state,
        respond,
      })) === "ready"
    )
      send("is that the gemini api key?");
    expect(send).toHaveBeenCalledWith("is that the gemini api key?");
  });

  it("waits for each approval before allowing a send", async () => {
    const { respond, run } = setup();
    let finish!: (result: { _tag: string }) => void;
    respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = run();
    expect(respond).toHaveBeenCalledTimes(1);
    finish({ _tag: "Success" });
    expect(await pending).toBe("ready");
    expect(respond.mock.calls.map(([id]) => id)).toEqual([a.requestId, b.requestId]);
  });
  it.each([undefined, { _tag: "Failure" }])("stops on a failed decline", async (result) => {
    const { respond, run } = setup();
    respond.mockResolvedValueOnce(result);
    expect(await run()).toBe("approval-failed");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("keeps the message unsent when a later decline fails or throws", async () => {
    const { respond, run } = setup();
    respond.mockRejectedValueOnce(new Error("offline"));
    const send = vi.fn();
    if ((await run()) === "ready") send();
    expect(send).not.toHaveBeenCalled();

    respond.mockReset();
    respond.mockResolvedValueOnce({ _tag: "Success" }).mockResolvedValueOnce({ _tag: "Failure" });
    if ((await run()) === "ready") send();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not respond after switching to a different chat", async () => {
    const { state, respond, run } = setup();
    state.threadKey = "other:thread";
    expect(await run()).toBe("blocked");
    expect(respond).not.toHaveBeenCalled();
  });
  it("blocks an unavailable decline before responding to any approval", async () => {
    const { state, respond, run } = setup();
    state.approvals = [a, { ...b, responseCapability: "not_resumable" }];
    expect(await run()).toBe("approval-failed");
    expect(respond).not.toHaveBeenCalled();
  });
  it("does not decline an approval without a decline option", async () => {
    const { state, respond, run } = setup();
    state.approvals = [{ ...a, options: [{ decision: "accept", label: "Allow" }] }];
    expect(await run()).toBe("approval-failed");
    expect(respond).not.toHaveBeenCalled();
  });
  it.each([
    "threadKey",
    "draftFingerprint",
    "pendingDraftWork",
    "blockingRequest",
    "responding",
  ] as const)("stops if %s changes while awaiting a decline", async (change) => {
    const { state, respond, run } = setup();
    respond.mockImplementationOnce(async () => {
      if (change === "threadKey") state.threadKey = "other:thread";
      if (change === "draftFingerprint") state.draftFingerprint = "edited";
      if (change === "pendingDraftWork") state.pendingDraftWork = true;
      if (change === "blockingRequest") state.blockingRequest = true;
      if (change === "responding") state.responding = [b.requestId];
      return { _tag: "Success" };
    });
    expect(await run()).not.toBe("ready");
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("skips an approval already resolved by another client", async () => {
    const { state, respond, run } = setup();
    state.approvals = [b];
    expect(await run()).toBe("ready");
    expect(respond.mock.calls.map(([id]) => id)).toEqual([b.requestId]);
  });
  it("does not answer approvals that arrive while attachments are preparing", async () => {
    const { state, respond, run } = setup();
    state.approvals.push(approval("new"));
    expect(await run()).toBe("changed");
    expect(respond).not.toHaveBeenCalled();
  });
  it("does not decline a newly arrived approval", async () => {
    const { state, respond, run } = setup();
    respond.mockImplementationOnce(async () => {
      state.approvals = [a, b, approval("new")];
      return { _tag: "Success" };
    });
    expect(await run()).toBe("changed");
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("blocks a question without declining", async () => {
    const { state, respond, run } = setup();
    state.blockingRequest = true;
    expect(await run()).toBe("blocked");
    expect(respond).not.toHaveBeenCalled();
  });
  it("keeps a normal send unchanged when there are no approvals", async () => {
    const { state, respond } = setup();
    state.approvals = [];
    expect(
      await prepareApprovalRedirect({
        threadKey: "env:thread",
        approvalIds: [],
        draftFingerprint: "draft-with-attachments",
        readState: () => state,
        respond,
      }),
    ).toBe("ready");
    expect(respond).not.toHaveBeenCalled();
    state.draftFingerprint = "changed while preparing";
    expect(
      await prepareApprovalRedirect({
        threadKey: "env:thread",
        approvalIds: [],
        draftFingerprint: "draft-with-attachments",
        readState: () => state,
        respond,
      }),
    ).toBe("changed");
    state.draftFingerprint = "draft-with-attachments";
    state.approvals = [a];
    expect(
      await prepareApprovalRedirect({
        threadKey: "env:thread",
        approvalIds: [],
        draftFingerprint: "draft-with-attachments",
        readState: () => state,
        respond,
      }),
    ).toBe("changed");
  });
  it("compares draft attachment bytes and context but ignores upload progress", () => {
    const file = new File(["one"], "note.txt", { type: "text/plain" });
    const draft = createEmptyThreadDraft();
    draft.prompt = "hello";
    draft.files = [
      {
        type: "file",
        id: "file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ];
    const fingerprint = approvalRedirectDraftFingerprint(draft);
    expect(
      approvalRedirectDraftFingerprint({
        ...draft,
        files: [{ ...draft.files[0]!, uploadedAttachmentId: "uploaded" }],
      }),
    ).toBe(fingerprint);
    const replacement = new File(["two"], "note.txt", { type: "text/plain" });
    expect(
      approvalRedirectDraftFingerprint({
        ...draft,
        files: [{ ...draft.files[0]!, file: replacement }],
      }),
    ).not.toBe(fingerprint);
    expect(approvalRedirectDraftFingerprint({ ...draft, prompt: "changed" })).not.toBe(fingerprint);
  });
});
