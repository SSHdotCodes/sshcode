// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  interrupt: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
    interruptTurn: "interrupt",
    resumeThreadQueue: "resume",
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "interrupt"
      ? state.interrupt
      : command === "resume"
        ? state.resume
        : async () => undefined,
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`),
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

it.each([false, true])("offers the correct action for a held=%s queue", async (isHeld) => {
  state.projection = { projection: { messages: [{ id: "message:queued" }] } };
  state.workflow = {
    activeRun: isHeld ? null : { id: "run:active" },
    canPromoteToSteer: false,
    canSendNow: !isHeld,
    steeringUnavailableReason: isHeld ? null : "This turn can't accept a steer.",
    isHeld,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued follow-up",
        attachments: [],
      },
    ],
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueuedRunsControl
          environmentId={"environment:test" as never}
          threadId={"thread:test" as never}
          optimisticMessages={[]}
          editingRunId={null}
          onEditQueuedRun={() => undefined}
          onCancelEdit={() => undefined}
          onImageExpand={() => undefined}
        />,
      ),
    );
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.some((button) => button.textContent?.trim() === "Steer")).toBe(false);
    expect(host.textContent).toContain(isHeld ? "Queue held" : "This turn can't accept a steer.");
    const action = buttons.find(
      (button) => button.textContent?.trim() === (isHeld ? "Send queued messages" : "Send now"),
    );
    expect(action).toBeDefined();
    await act(async () => action!.click());
    if (isHeld) {
      expect(state.resume).toHaveBeenCalledWith({
        environmentId: "environment:test",
        input: { threadId: "thread:test" },
      });
    } else {
      expect(state.interrupt).toHaveBeenCalledWith({
        environmentId: "environment:test",
        input: { threadId: "thread:test", runId: "run:active", sendQueuedRunId: "run:queued" },
      });
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        onImageExpand={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        onImageExpand={() => undefined}
      />,
    );

    expect(html).toContain("https://assets.test/attachment-1");
    expect(html).toContain("Queued with a screenshot");
    expect(html).toContain("Edit queued message");
    expect(html).toContain("Reorder queued message");
    expect(html).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[
          {
            id: "message:acknowledged" as never,
            inputIntent: "queued_turn",
            text: "hello",
            attachments: [],
          },
        ]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        onImageExpand={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("keeps accepted text without the saving indicator while the queue projection lags", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = { queuedRuns: [], activeRun: null };
    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        threadId={"thread:test" as never}
        optimisticMessages={[
          {
            id: "accepted" as never,
            inputIntent: "queued_turn",
            text: "Keep this follow-up",
            acknowledged: true,
          },
        ]}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        onImageExpand={() => undefined}
      />,
    );
    expect(html).toContain("Keep this follow-up");
    expect(html).not.toContain("Saving queued message");
  });

  it("shows one accepted row when the queued run arrives before its message", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = {
      ...workflowWithAttachment(),
      queuedRuns: [
        {
          run: { id: "run:queued", userMessageId: "accepted" },
          text: "Queued message",
          attachments: [],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        threadId={"thread:test" as never}
        optimisticMessages={[
          {
            id: "accepted" as never,
            inputIntent: "queued_turn",
            text: "My queued text",
            acknowledged: true,
          },
        ]}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        onImageExpand={() => undefined}
      />,
    );
    expect(html.match(/<li\b/g)).toHaveLength(1);
    expect(html).toContain("My queued text");
    expect(html).not.toContain("Saving queued message");
  });

  it("keeps the original queued message visible while editing", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={"run:queued" as never}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        onImageExpand={() => undefined}
      />,
    );

    expect(html).toContain("Queued with a screenshot");
  });
});
