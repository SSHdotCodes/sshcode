// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  CommandId,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  SideChatId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { PendingSend } from "./pending-send-model";

const h = vi.hoisted(() => ({
  connected: false,
  permitted: true,
  wake: () => {},
  open: vi.fn(),
  answer: vi.fn(),
  saved: new Map<string, PendingSend>(),
  remove: vi.fn(),
  loads: 0,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../connection/network-recovery", () => ({
  subscribeNetworkRecovery: (wake: () => void) => {
    h.wake = wake;
    return () => {};
  },
}));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: "desk", connectionState: h.connected ? "connected" : "offline" },
    ],
  }),
}));
vi.mock("./session", () => ({
  useEnvironmentsWithScope: () => new Set(h.permitted ? ["desk"] : []),
  readEnvironmentScope: () => h.permitted,
}));
vi.mock("./server", () => ({ serverEnvironment: { openSideChat: "open" } }));
vi.mock("./threads", () => ({ threadEnvironment: { respondToUserInput: "answer" } }));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "open" ? h.open : h.answer),
}));
vi.mock("./pending-sends", async () => {
  const { createPendingSendManager } = await import("./pending-send-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  return {
    pendingSends: createPendingSendManager(appAtomRegistry, {
      load: async () => {
        h.loads++;
        return { sends: [...h.saved.values()], errors: [] };
      },
      write: async (send) => {
        h.saved.set(send.id, send);
      },
      remove: async (send) => {
        await h.remove();
        h.saved.delete(send.id);
      },
    }),
    acknowledgedSideChatsAtom: Atom.make({}).pipe(Atom.keepAlive),
    acknowledgedUserInputKeysAtom: Atom.make(new Set()).pipe(Atom.keepAlive),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { pendingSends } from "./pending-sends";
import { usePendingSendDrain } from "./use-pending-send-drain";
import { isClosedRuntimeRequestMessage } from "./pending-send-model";

const base = {
  id: CommandId.make("stable-id"),
  environmentId: EnvironmentId.make("desk"),
  threadId: ThreadId.make("thread"),
  createdAt: "2026-10-20T12:00:00.000Z",
};
let root: Root;
function Worker() {
  usePendingSendDrain();
  return null;
}
async function render() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Worker />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  h.connected = false;
  h.permitted = true;
  h.saved.clear();
  h.remove.mockReset();
  h.loads = 0;
  h.open.mockReset();
  h.answer.mockReset();
  appAtomRegistry.set(pendingSends.sendsAtom, []);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

it.each(["side-question", "user-input"] as const)(
  "sends a restored offline %s automatically with its persisted id",
  async (kind) => {
    const send: PendingSend =
      kind === "side-question"
        ? { ...base, kind, prompt: "question" }
        : {
            ...base,
            kind,
            requestId: RuntimeRequestId.make("card"),
            answers: { choice: "keep this answer" },
          };
    h.saved.set(send.id, send);
    h.open.mockResolvedValue(
      AsyncResult.success({
        sideChatId: SideChatId.make("side"),
        threadId: base.threadId,
        kind: "btw",
        status: "running",
        messages: [],
        error: null,
      }),
    );
    h.answer.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
    await render();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.answer).not.toHaveBeenCalled();
    h.connected = true;
    await render();
    const command = kind === "side-question" ? h.open : h.answer;
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0].input).toMatchObject(
      kind === "side-question"
        ? { messageId: send.id, prompt: "question" }
        : { commandId: send.id, answers: { choice: "keep this answer" } },
    );
    expect(h.saved.size).toBe(0);
  },
);

it("retries a lost acknowledgment immediately on a network wake with the same id", async () => {
  h.connected = true;
  h.saved.set(base.id, {
    ...base,
    kind: "user-input",
    requestId: RuntimeRequestId.make("card"),
    answers: { a: "yes" },
  });
  const delivered = new Set<string>();
  let effects = 0;
  h.answer.mockImplementation(async ({ input }: { input: { commandId: string } }) => {
    if (!delivered.has(input.commandId)) {
      delivered.add(input.commandId);
      effects++;
    }
    return h.answer.mock.calls.length === 1
      ? AsyncResult.failure(Cause.fail({ _tag: "EnvironmentRpcUnavailableError" }))
      : AsyncResult.success({ sequence: 1 });
  });
  await render();
  expect(h.answer).toHaveBeenCalledOnce();
  expect(h.saved.size).toBe(1);
  await act(async () => h.wake());
  expect(h.answer).toHaveBeenCalledTimes(2);
  expect(h.answer.mock.calls[1]?.[0].input.commandId).toBe(base.id);
  expect(effects).toBe(1);
  expect(h.saved.size).toBe(0);
});

it("keeps a rejected answer visible and does not repeatedly resend it", async () => {
  h.connected = true;
  h.saved.set(base.id, {
    ...base,
    kind: "user-input",
    requestId: RuntimeRequestId.make("card"),
    answers: { a: "yes" },
  });
  h.answer.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail({ _tag: "OrchestrationDispatchCommandError", message: "Question closed" }),
    ),
  );
  await render();
  expect(appAtomRegistry.get(pendingSends.sendsAtom)[0]?.error).toBe("Could not send. Try again.");
  await act(async () => {
    h.wake();
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(h.answer).toHaveBeenCalledOnce();
  expect(h.saved.size).toBe(1);
});

it.each(["OrchestrationV2DispatchCommandError", "OrchestrationDispatchCommandError"])(
  "drops a closed-card %s without offering a retry",
  async (tag) => {
    h.connected = true;
    h.saved.set(base.id, {
      ...base,
      kind: "user-input",
      requestId: RuntimeRequestId.make("card"),
      answers: { a: "Restart now (Recommended)" },
    });
    h.answer.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail({
          _tag: tag,
          message: "Runtime request runtime-request:ask-user:thread:card is resolved.",
        }),
      ),
    );
    await render();
    expect(h.answer).toHaveBeenCalledOnce();
    expect(h.saved.size).toBe(0);
    expect(appAtomRegistry.get(pendingSends.sendsAtom)).toEqual([]);
  },
);

it("clears a saved failed answer to a closed card without resending it", async () => {
  h.connected = true;
  h.saved.set(base.id, {
    ...base,
    kind: "user-input",
    requestId: RuntimeRequestId.make("card"),
    answers: { a: "yes" },
    error: "Runtime request runtime-request:ask-user:thread:card is resolved.",
  });
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(h.answer).not.toHaveBeenCalled();
  expect(h.saved.size).toBe(0);
});

it.each([
  ["Runtime request runtime-request:ask-user:t:c is resolved.", true],
  ["Runtime request r was not found.", true],
  ["Runtime request r no longer exists on thread t.", true],
  ["Runtime request r is pending.", false],
  ["Runtime request r on thread t is not ready for response execution.", false],
  ["Question closed", false],
] as const)("reads %s as a closed card: %s", (message, closed) => {
  expect(isClosedRuntimeRequestMessage(message)).toBe(closed);
});

it("waits for the destination's operate grant before delivering a restored send", async () => {
  h.connected = true;
  h.permitted = false;
  h.saved.set(base.id, { ...base, kind: "side-question", prompt: "keep me" });
  await render();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.saved.size).toBe(1);
});

it("replays immediately when the old socket fails after the replacement is ready", async () => {
  h.connected = true;
  h.saved.set(base.id, { ...base, kind: "side-question", prompt: "question" });
  const first = Promise.withResolvers<unknown>();
  h.open.mockReturnValueOnce(first.promise).mockResolvedValueOnce(AsyncResult.success({}));
  await render();
  h.connected = false;
  await render();
  h.connected = true;
  await render();
  await act(async () => first.resolve(AsyncResult.failure(Cause.interrupt())));
  expect(h.open).toHaveBeenCalledTimes(2);
  expect(h.saved.size).toBe(0);
  await act(async () => h.wake());
  expect(h.loads).toBe(1);
});

it("finishes acknowledged cleanup offline after a transient disk failure", async () => {
  h.connected = true;
  h.saved.set(base.id, { ...base, kind: "side-question", prompt: "question" });
  h.open.mockResolvedValue(AsyncResult.success({}));
  h.remove.mockRejectedValueOnce(new Error("disk busy"));
  await render();
  expect(h.saved.size).toBe(1);
  expect(appAtomRegistry.get(pendingSends.awaitingAckAtom)).toEqual([]);
  h.connected = false;
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(h.saved.size).toBe(0);
  expect(h.open).toHaveBeenCalledOnce();
});
