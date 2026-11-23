// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { CommandId, EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  answer: vi.fn(),
  approve: vi.fn(),
  dismiss: vi.fn(),
  pending: null as PendingThreadRequests | null,
  text: "",
  attachments: [] as { id: string }[],
}));
vi.mock("./pending-sends", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    acknowledgedUserInputKeysAtom: Atom.make(new Set()).pipe(Atom.keepAlive),
    pendingSends: {
      sendsAtom: Atom.make([]).pipe(Atom.keepAlive),
      enqueue: (...args: unknown[]) => commands.answer(...args),
    },
    pendingSendMetadata: () => ({ id: "stable-answer-id", createdAt: "2026-10-20T12:00:00.000Z" }),
  };
});
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}).pipe(Atom.keepAlive),
    clearComposerDraft: vi.fn(),
    getComposerDraftSnapshot: () => ({ text: commands.text, attachments: commands.attachments }),
    setComposerDraftText: (_key: string, text: string) => {
      commands.text = text;
    },
  };
});
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await import("../lib/composerAttachmentUploadQueue")),
    composerAttachmentUploadsAtom: Atom.make({}).pipe(Atom.keepAlive),
  };
});
vi.mock("./entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./session", () => ({ readEnvironmentScope: () => true }));
vi.mock("./threads", () => ({
  threadEnvironment: {
    respondToApproval: "approve",
    respondToUserInput: "answer",
    dismissUserInput: "dismiss",
  },
}));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "answer"
      ? commands.answer
      : command === "approve"
        ? commands.approve
        : commands.dismiss,
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadPendingRequests: () => commands.pending,
}));

import { appAtomRegistry } from "./atom-registry";
import { pendingSends, acknowledgedUserInputKeysAtom } from "./pending-sends";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

let root: Root;
let actions: ReturnType<typeof useSelectedThreadRequests>;
function Probe() {
  const requests = useSelectedThreadRequests();
  useLayoutEffect(() => {
    actions = requests;
  });
  return null;
}
function render() {
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commands.text = "";
  commands.attachments = [];
  commands.answer.mockReset();
  commands.approve.mockReset();
  appAtomRegistry.set(pendingSends.sendsAtom, []);
  appAtomRegistry.set(acknowledgedUserInputKeysAtom, new Set<string>());
  commands.dismiss.mockReset();
  commands.pending = {
    approvals: [],
    userInputs: [
      {
        requestId: RuntimeRequestId.make("request-1"),
        createdAt: "2026-10-16T12:00:00Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "question",
            header: "Question",
            question: "What next?",
            options: [],
            allowCustomAnswer: true,
            initialAnswer: "Review the diff",
            multiSelect: false,
          },
        ],
      },
    ],
  };
  root = createRoot(document.createElement("div"));
  render();
  expect(actions.activePendingUserInputAnswers).toEqual({ question: "Review the diff" });
});
afterEach(() => act(() => root.unmount()));

describe("pending question actions", () => {
  it("restores a saved answer after initial defaults load and keeps it pending until acknowledged", async () => {
    const queued = {
      id: CommandId.make("restored-answer"),
      kind: "user-input" as const,
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { question: "The answer I actually sent" },
      createdAt: "2026-10-20T12:00:00.000Z",
    };
    await act(async () => appAtomRegistry.set(pendingSends.sendsAtom, [queued]));
    expect(actions.activePendingUserInputAnswers).toEqual({
      question: "The answer I actually sent",
    });
    expect(actions.respondingUserInputId).toBe(queued.requestId);
    expect(actions.userInputDeliveryStatus).toContain("Waiting for network");
    await act(async () => {
      appAtomRegistry.set(
        acknowledgedUserInputKeysAtom,
        new Set(["environment-1:thread-1:user-input:request-1"]),
      );
      appAtomRegistry.set(pendingSends.sendsAtom, []);
    });
    expect(actions.respondingUserInputId).toBe(queued.requestId);
    expect(actions.userInputDeliveryStatus).toBe("Answer sent");
    act(() =>
      actions.onChangeUserInputCustomAnswer(queued.requestId, "question", "Review the diff"),
    );
  });

  it.each(["answer", "dismiss"] as const)(
    "sends only one response when %s and the other action are tapped together",
    async (first) => {
      const pending = Promise.withResolvers<{ _tag: "Success" }>();
      commands.answer.mockReturnValue(pending.promise);
      commands.dismiss.mockReturnValue(pending.promise);
      let firstResult: Promise<unknown>;
      act(() => {
        firstResult =
          first === "answer" ? actions.onSubmitUserInput() : actions.onDismissUserInput();
        void (first === "answer" ? actions.onDismissUserInput() : actions.onSubmitUserInput());
      });
      expect(commands.answer).toHaveBeenCalledTimes(first === "answer" ? 1 : 0);
      expect(commands.dismiss).toHaveBeenCalledTimes(first === "dismiss" ? 1 : 0);
      await act(async () => {
        pending.resolve({ _tag: "Success" });
        await firstResult;
      });
    },
  );

  it("ignores a second dismissal before the first finishes", async () => {
    const pending = Promise.withResolvers<{ _tag: "Success" }>();
    commands.dismiss.mockReturnValue(pending.promise);
    let result: Promise<unknown>;
    act(() => {
      result = actions.onDismissUserInput();
      void actions.onDismissUserInput();
    });
    expect(commands.dismiss).toHaveBeenCalledTimes(1);
    expect(commands.dismiss).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: { threadId: ThreadId.make("thread-1"), requestId: RuntimeRequestId.make("request-1") },
    });
    await act(async () => {
      pending.resolve({ _tag: "Success" });
      await result;
    });
  });

  it("allows an answer after dismissal fails", async () => {
    commands.dismiss.mockResolvedValue({ _tag: "Failure" });
    commands.answer.mockResolvedValue({ _tag: "Success" });
    await act(async () => {
      await actions.onDismissUserInput();
    });
    await act(async () => {
      await actions.onSubmitUserInput();
    });
    expect(commands.answer).toHaveBeenCalledOnce();
    expect(actions.respondingUserInputId).toBeNull();
  });

  it("sends only one approval decision while the first is in flight", async () => {
    commands.pending = {
      approvals: [
        {
          requestId: RuntimeRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-10-16T12:00:00Z",
          detail: "rm -rf /tmp/build",
          responseCapability: "live",
        },
      ],
      userInputs: commands.pending!.userInputs,
    };
    render();
    const pending = Promise.withResolvers<{ _tag: "Success" }>();
    commands.approve.mockReturnValue(pending.promise);
    let result: Promise<unknown> = Promise.resolve();
    act(() => {
      result = actions.onRespondToApproval(RuntimeRequestId.make("approval-1"), "accept");
      void actions.onRespondToApproval(RuntimeRequestId.make("approval-1"), "decline");
    });
    expect(commands.approve).toHaveBeenCalledTimes(1);
    expect(commands.approve).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: {
        threadId: ThreadId.make("thread-1"),
        requestId: RuntimeRequestId.make("approval-1"),
        decision: "accept",
      },
    });
    expect(actions.respondingApprovalId).toBe(RuntimeRequestId.make("approval-1"));
    await act(async () => {
      pending.resolve({ _tag: "Success" });
      await result;
    });
    expect(actions.respondingApprovalId).toBeNull();
  });

  it("keeps native callback questions from being dismissed", async () => {
    commands.pending = {
      approvals: [],
      userInputs: commands.pending!.userInputs.map((request) => ({
        ...request,
        dismissible: false,
      })),
    };
    commands.dismiss.mockResolvedValue({ _tag: "Success" });
    render();
    await act(async () => {
      await actions.onDismissUserInput();
    });
    expect(commands.dismiss).not.toHaveBeenCalled();
  });
});

describe("composer answers", () => {
  it("adopts a draft on arrival and sends the latest text in one tap", async () => {
    commands.pending = { approvals: [], userInputs: [] };
    render();
    commands.text = "I was typing";
    commands.pending = {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("composer-question"),
          createdAt: "2026-11-16T12:00:00Z",
          responseCapability: "live",
          dismissible: false,
          questions: [
            {
              id: "q",
              header: "Question",
              question: "Which?",
              options: [{ label: "Option", description: "Option" }],
              multiSelect: false,
            },
          ],
        },
      ],
    };
    render();
    expect(commands.text).toBe("I was typing");
    expect(actions.activePendingUserInputDrafts.q?.customAnswer).toBe("I was typing");
    commands.text = "I was typing more";
    await act(async () => {
      await actions.onSubmitUserInput();
    });
    expect(commands.answer).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { q: "I was typing more" } }),
    );
  });

  it("keeps custom text as the normal draft when the question disappears", () => {
    commands.pending = {
      approvals: [],
      userInputs: commands.pending!.userInputs.map((request) => ({
        ...request,
        requestId: RuntimeRequestId.make("keep-question"),
      })),
    };
    render();
    act(() =>
      actions.onChangeUserInputCustomAnswer(
        RuntimeRequestId.make("keep-question"),
        "question",
        "Keep this",
      ),
    );
    commands.pending = { approvals: [], userInputs: [] };
    render();
    expect(commands.text).toBe("Keep this");
  });

  it("keeps the active question's text when a multi-question card disappears", () => {
    commands.pending = {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("multi-question"),
          createdAt: "2026-11-16T12:00:00Z",
          responseCapability: "live",
          dismissible: false,
          questions: ["first", "second"].map((id) => ({
            id,
            header: id,
            question: "Which?",
            options: [],
            multiSelect: false,
          })),
        },
      ],
    };
    commands.text = "First answer";
    render();
    act(() =>
      actions.onChangeUserInputCustomAnswer(
        RuntimeRequestId.make("multi-question"),
        "second",
        "Second answer",
      ),
    );
    expect(actions.activePendingUserInputQuestionId).toBe("second");
    expect(actions.activePendingUserInputDrafts.first?.customAnswer).toBe("First answer");
    commands.pending = { approvals: [], userInputs: [] };
    render();
    expect(commands.text).toBe("Second answer");
  });

  it("leaves normal attachments in the draft when submitting a text answer", async () => {
    commands.attachments = [{ id: "normal-image" }, { id: "normal-file" }];
    act(() =>
      actions.onChangeUserInputCustomAnswer(
        RuntimeRequestId.make("request-1"),
        "question",
        "Review the diff",
      ),
    );
    await act(async () => {
      await actions.onSubmitUserInput();
    });
    expect(commands.attachments).toEqual([{ id: "normal-image" }, { id: "normal-file" }]);
    expect(commands.answer).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { question: "Review the diff" } }),
    );
    expect(commands.answer.mock.calls[0]?.[0]).not.toHaveProperty("attachmentsByQuestionId");
  });

  it("does not submit a whitespace-only composer answer", async () => {
    commands.pending = {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("whitespace-question"),
          createdAt: "2026-11-16T12:00:00Z",
          responseCapability: "live",
          dismissible: false,
          questions: [
            { id: "q", header: "Question", question: "Which?", options: [], multiSelect: false },
          ],
        },
      ],
    };
    commands.text = " \n";
    render();
    await act(async () => {
      await actions.onSubmitUserInput();
    });
    expect(commands.answer).not.toHaveBeenCalled();
  });
});
