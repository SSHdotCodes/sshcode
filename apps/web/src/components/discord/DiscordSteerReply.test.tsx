// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  MessageId,
  ThreadId,
  TurnItemId,
  RunId,
  type CasualVoiceDecision,
  type CasualVoiceDisplay,
} from "@t3tools/contracts";
import {
  parseCasualDecisions,
  segmentCasualMessage,
  type SteerReasoningReply,
} from "@t3tools/shared/casualVoice";
import { DiscordSteerReply } from "./DiscordSteerReply";

const state = vi.hoisted(() => ({
  display: null as CasualVoiceDisplay | null,
  decision: null as CasualVoiceDecision | null,
  pending: false,
}));
vi.mock("./useCasualVoice", () => ({
  useCasualMessage: () => {
    const [showOriginal, toggle] = useState(false);
    return {
      display: showOriginal ? null : state.display,
      decision: state.decision,
      rewritten: Boolean(state.display),
      pending: state.pending,
      live: false,
      showOriginal,
      toggle: () => toggle((value) => !value),
    };
  },
}));
vi.mock("./CasualBurst", async (original) => ({
  ...(await original<typeof import("./CasualBurst")>()),
  useCasualVisibility: () => ({ ref: () => {}, visible: true, reducedMotion: true }),
}));
const now = DateTime.makeUnsafe("2026-10-27T00:00:00Z");
const base = {
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
  parentItemId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  title: null,
  status: "completed" as const,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const reply: SteerReasoningReply = {
  steer: {
    ...base,
    id: TurnItemId.make("steer-item"),
    ordinal: 1,
    type: "user_message",
    messageId: MessageId.make("steer"),
    text: "Check the earlier result.\nIt might matter.",
    inputIntent: "steer",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
  items: [
    {
      ...base,
      id: TurnItemId.make("first"),
      ordinal: 2,
      type: "reasoning",
      text: "I Found The Earlier Result.",
      streaming: false,
    },
    {
      ...base,
      id: TurnItemId.make("second"),
      ordinal: 3,
      type: "reasoning",
      text: "Private planning follows.",
      streaming: false,
    },
  ],
  closed: true,
};
let root: Root;
let host: HTMLDivElement;
const render = (text: string): ReactNode => <p>{text}</p>;
const props = {
  reply,
  rowId: "steer-reply",
  environmentId: null,
  agent: "buddy",
  header: (
    <div data-dc-message-header>
      <span data-dc-message-avatar />
      <span>buddy</span>
    </div>
  ),
  render,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.display = null;
  state.decision = null;
  state.pending = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("stays silent when a steer rewrite does not parse", async () => {
  await act(async () => root.render(<DiscordSteerReply {...props} />));
  expect(host.textContent).toBe("");
  expect(host.querySelector("[data-message-role=assistant]")).toBeNull();
  expect(host.querySelector("[data-casual-bubble]")).toBeNull();
});
it.each(["hide", "status"])(
  "keeps a valid all-%s decision silent, with no header or hidden-thought disclosure",
  async (kind) => {
    state.display = parseCasualDecisions(
      segmentCasualMessage(
        kind === "hide" ? "I must check 42." : "Let me check the tests.",
        "update",
        {
          source: "reasoning",
          replyTo: "continue",
        },
      ),
      kind === "hide" ? "1 hide: filler" : "1 status: checking the tests",
    )!;
    await act(async () => root.render(<DiscordSteerReply {...props} />));
    expect(host.textContent).toBe("");
    expect(host.querySelector("[data-casual-bubble]")).toBeNull();
    expect(host.querySelector("[data-dc-reply-reference]")).toBeNull();
  },
);
it("does not flash a fallback while the model is still deciding", async () => {
  state.pending = true;
  await act(async () => root.render(<DiscordSteerReply {...props} />));
  expect(host.textContent).toBe("");
  state.pending = false;
  await act(async () => root.render(<DiscordSteerReply {...props} />));
  expect(host.textContent).toBe("");
});
it("shows the original say segments when the wording guard rejects a send", async () => {
  state.decision = { kind: "send", segments: [1] };
  await act(async () => root.render(<DiscordSteerReply {...props} />));
  expect(host.textContent).toContain(reply.items[0]!.text);
  expect(host.textContent).not.toContain(reply.items[1]!.text);
  expect(host.querySelector("[data-dc-reply-reference]")?.textContent).toBe(
    "Check the earlier result. It might matter.",
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[data-casual-voice-actions] button")!.click(),
  );
  expect(host.textContent).toContain(reply.items[0]!.text);
  expect(host.textContent).toContain(reply.items[1]!.text);
});
it("stays silent when a rejected steer decided not to send", async () => {
  state.decision = { kind: "quiet" };
  await act(async () => root.render(<DiscordSteerReply {...props} />));
  expect(host.textContent).toBe("");
  expect(host.querySelector("[data-casual-bubble]")).toBeNull();
});
it("shows the original selected window on request after a successful rewrite", async () => {
  const original = reply.items.map((item) => item.text).join("\n\n");
  state.display = parseCasualDecisions(
    segmentCasualMessage(original, "update", { source: "reasoning", replyTo: reply.steer.text }),
    "1 say: i found the earlier result.\n2 hide: filler",
  )!;
  await act(async () => root.render(<DiscordSteerReply {...props} />));
  expect(host.textContent).toContain("i found the earlier result.");
  expect(host.querySelector("[data-casual-hidden]")).toBeNull();
  // Original thoughts are available only through the explicit original-text action.
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[data-casual-voice-actions] button")!.click(),
  );
  expect(host.textContent).toContain(reply.items[0]!.text);
  expect(host.textContent).toContain(reply.items[1]!.text);
});
it("shows a normal-layout steer reply without Discord chrome", async () => {
  const original = reply.items.map((item) => item.text).join("\n\n");
  state.display = parseCasualDecisions(
    segmentCasualMessage(original, "update", { source: "reasoning", replyTo: reply.steer.text }),
    "1 say: i found the earlier result.\n2 hide: filler",
  )!;
  await act(async () => root.render(<DiscordSteerReply {...props} plain header={null} />));
  expect(host.textContent).toContain("replying to your steer");
  expect(host.textContent).toContain("Check the earlier result. It might matter.");
  expect(host.textContent).toContain("i found the earlier result.");
  expect(host.textContent).toContain("show original");
  expect(host.querySelector("[data-casual-bubble]")).not.toBeNull();
  expect(host.querySelector("[data-dc-message-header]")).toBeNull();
  expect(host.querySelector("[data-dc-message-avatar]")).toBeNull();
});
