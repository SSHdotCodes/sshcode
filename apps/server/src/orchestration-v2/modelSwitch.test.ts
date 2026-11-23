import {
  ContextHandoffId,
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelSwitchSince } from "./modelSwitch.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = (model: string) => ({ instanceId, model });
const run = (
  message: string,
  ordinal: number,
  model: string,
  status: OrchestrationV2ThreadProjection["runs"][number]["status"] = "completed",
) =>
  ({
    id: RunId.make(message),
    ordinal,
    status,
    completedAt: null,
    contextHandoffId: null,
    userMessageId: MessageId.make(message),
    modelSelection: selection(model),
  }) as OrchestrationV2ThreadProjection["runs"][number];
const shown = (...messages: ReadonlyArray<string>) =>
  messages.map((message) => ({
    type: "user_message",
    runId: RunId.make(message),
    messageId: MessageId.make(message),
    inputIntent: "turn_start",
    status: "completed",
    text: message,
    attachments: [],
  })) as unknown as OrchestrationV2ThreadProjection["turnItems"];

// A wake run's message becomes a notification row, which keeps no message id.
const notified = (...runs: ReadonlyArray<string>) =>
  runs.map((runId) => ({
    type: "notification",
    runId: RunId.make(runId),
  })) as unknown as OrchestrationV2ThreadProjection["turnItems"];

describe("modelSwitchSince", () => {
  it("measures from the latest run whose message is in the timeline", () => {
    // B failed before it started; its message shows "a -> b", so the next one must show "b -> a".
    expect(
      modelSwitchSince(
        {
          runs: [
            run("first", 1, "a"),
            run("failed", 2, "b", "failed"),
            run("queued", 3, "c", "queued"),
            run("undone", 4, "d", "rolled_back"),
          ],
          turnItems: shown("first", "failed", "queued", "undone"),
        },
        selection("a"),
      ),
    ).toEqual({ modelSwitch: { from: selection("b"), to: selection("a") } });
  });

  it("skips messages clients hide", () => {
    const [first, pending, compact] = shown("first", "pending", "/compact");
    expect(
      modelSwitchSince(
        {
          runs: [
            run("first", 1, "a"),
            run("pending", 2, "b", "cancelled"),
            run("/compact", 3, "c"),
          ],
          turnItems: [
            first!,
            { ...pending!, inputIntent: "queued_turn", status: "pending" },
            compact!,
          ] as OrchestrationV2ThreadProjection["turnItems"],
        },
        selection("c"),
      ),
    ).toEqual({ modelSwitch: { from: selection("a"), to: selection("c") } });
  });

  it("shows a change on the wake run that first ran on it, once", () => {
    const before = { runs: [run("first", 1, "a")], turnItems: shown("first") };
    expect(modelSwitchSince(before, selection("b"))).toEqual({
      modelSwitch: { from: selection("a"), to: selection("b") },
    });
    // The wake's notification row drew "a -> b", so later runs on b draw nothing.
    const afterWake = {
      runs: [...before.runs, run("wake", 2, "b")],
      turnItems: [...before.turnItems, ...notified("wake")],
    };
    expect(modelSwitchSince(afterWake, selection("b"))).toEqual({});
  });

  it("shows a change on the answered question that first ran on it, once", () => {
    const afterAnswer = {
      runs: [run("first", 1, "a"), run("async-answer:question", 2, "b")],
      turnItems: shown("first", "async-answer:question"),
    };
    expect(modelSwitchSince(afterAnswer, selection("b"))).toEqual({});
  });

  it("chains changes across wake runs", () => {
    const projection = {
      runs: [run("first", 1, "a"), run("wake", 2, "b"), run("async-answer:question", 3, "b")],
      turnItems: [...shown("first", "async-answer:question"), ...notified("wake")],
    };
    expect(modelSwitchSince(projection, selection("c"))).toEqual({
      modelSwitch: { from: selection("b"), to: selection("c") },
    });
    expect(
      modelSwitchSince(
        {
          runs: [...projection.runs, run("later-wake", 4, "c")],
          turnItems: [...projection.turnItems, ...notified("later-wake")],
        },
        selection("a"),
      ),
    ).toEqual({ modelSwitch: { from: selection("c"), to: selection("a") } });
  });

  it("records nothing across wake runs when nothing changed", () => {
    expect(
      modelSwitchSince(
        {
          runs: [run("first", 1, "a"), run("wake", 2, "a")],
          turnItems: [...shown("first"), ...notified("wake")],
        },
        selection("a"),
      ),
    ).toEqual({});
  });

  it("ignores a wake that never left the queue", () => {
    expect(
      modelSwitchSince(
        {
          runs: [run("first", 1, "a"), run("wake", 2, "b", "cancelled")],
          turnItems: shown("first"),
        },
        selection("b"),
      ),
    ).toEqual({ modelSwitch: { from: selection("a"), to: selection("b") } });
  });

  it("counts a wake whose handoff row shows the swap", () => {
    const wake = {
      ...run("wake", 2, "other"),
      contextHandoffId: ContextHandoffId.make("handoff"),
    };
    expect(
      modelSwitchSince(
        { runs: [run("first", 1, "a"), wake], turnItems: shown("first") },
        selection("other"),
      ),
    ).toEqual({});
  });

  it("records nothing for a first run or an unchanged selection", () => {
    expect(modelSwitchSince({ runs: [], turnItems: [] }, selection("a"))).toEqual({});
    // A fork's first message compares with the run it forked from.
    expect(modelSwitchSince({ runs: [], turnItems: [] }, selection("a"), selection("b"))).toEqual({
      modelSwitch: { from: selection("b"), to: selection("a") },
    });
    expect(
      modelSwitchSince({ runs: [run("first", 1, "a")], turnItems: shown("first") }, selection("a")),
    ).toEqual({});
  });
});
