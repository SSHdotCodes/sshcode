import { describe, expect, it } from "vite-plus/test";

import {
  SUBAGENT_MODEL_CHOICES,
  subagentModelChoices,
  usualOptionsLabel,
} from "./subagentModelChoices.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-17T20:00:00.000Z");
const ran = (daysAgo: number, instanceId: string, model: string, effort?: string) => ({
  startedAt: now - daysAgo * DAY,
  modelSelection: {
    instanceId,
    model,
    ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
  },
});
const chat = (daysAgo: number, instanceId: string, model: string) => ({
  createdBy: "user",
  createdAt: now - daysAgo * DAY,
  modelSelection: { instanceId, model },
});

describe("models offered for a subagent the user starts", () => {
  it("leads with what this chat's subagents ran on, the latest first and as it last ran", () => {
    const choices = subagentModelChoices({
      subagents: [
        ran(0.1, "codex_work", "gpt-6.2-astra", "xhigh"),
        ran(0.2, "codex_work", "gpt-6.2-astra", "high"),
        ran(0.3, "codex_work", "gpt-6.2-astra", "high"),
        ran(1, "codex_work", "gpt-6.2-sol", "xhigh"),
      ],
      chats: [
        chat(1, "claudeAgent", "claude-fable-5-2"),
        chat(2, "claudeAgent", "claude-fable-5-2"),
      ],
      now,
    });
    expect(choices).toEqual([
      {
        instanceId: "codex_work",
        model: "gpt-6.2-astra",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      {
        instanceId: "codex_work",
        model: "gpt-6.2-sol",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      { instanceId: "claudeAgent", model: "claude-fable-5-2" },
    ]);
  });

  it("lists a model once when the user also starts chats on it", () => {
    const choices = subagentModelChoices({
      subagents: [ran(1, "codex", "gpt-6.2-sol", "high")],
      chats: [chat(1, "codex", "gpt-6.2-sol"), chat(1, "claudeAgent", "claude-opus-5-5")],
      now,
    });
    expect(choices.map((choice) => choice.model)).toEqual(["gpt-6.2-sol", "claude-opus-5-5"]);
    // The subagents' options win: that is how this chat runs it.
    expect(choices[0]?.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("falls back to the models the user starts chats with when the chat has no subagents", () => {
    expect(
      subagentModelChoices({ subagents: [], chats: [chat(3, "grok", "grok-5")], now }),
    ).toEqual([{ instanceId: "grok", model: "grok-5" }]);
  });

  it("drops anything older than a month and stays short", () => {
    const choices = subagentModelChoices({
      subagents: [
        ...Array.from({ length: 30 }, () => ran(0.5, "codex_work", "gpt-6.2-astra")),
        ran(45, "codex", "long-ago"),
        ...["a", "b", "c", "d", "e", "f", "g"].flatMap((name) =>
          Array.from({ length: 10 }, () => ran(1, "open", name)),
        ),
      ],
      chats: [],
      now,
    });
    expect(choices.map((choice) => choice.model)).not.toContain("long-ago");
    expect(choices).toHaveLength(SUBAGENT_MODEL_CHOICES);
  });

  it("offers nothing when there is no history at all", () => {
    expect(subagentModelChoices({ subagents: [], chats: [], now })).toEqual([]);
  });

  it("opens on the model the chat's last subagent ran on, not on last week's bulk", () => {
    const choices = subagentModelChoices({
      subagents: [
        ...Array.from({ length: 21 }, () => ran(3, "claudeAgent", "claude-opus-5-5")),
        ...Array.from({ length: 8 }, (_, index) => ran(0.05 * index, "codex_work", "gpt-6.2-sol")),
        ...Array.from({ length: 5 }, (_, index) =>
          ran(0.1 + 0.05 * index, "codex_work", "gpt-6.2-astra"),
        ),
      ],
      chats: [],
      now,
    });
    expect(choices.map((choice) => choice.model)).toEqual([
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "claude-opus-5-5",
    ]);
  });

  it("leaves out what cannot be offered before cutting the list to size", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const choices = subagentModelChoices({
      subagents: names.map((name, index) => ran(0.1 * (index + 1), "open", name)),
      chats: [chat(1, "open", "a"), chat(1, "claudeAgent", "retired")],
      now,
      // The two latest were replaced by a newer release.
      accepts: (model) => !["a", "b", "retired"].includes(model.model),
    });
    expect(choices.map((choice) => choice.model)).toEqual(["c", "d", "e", "f", "g", "h"]);
  });
});

describe("the effort and speed named beside a model", () => {
  it("names effort and a speed that is not the default, and nothing else", () => {
    expect(
      usualOptionsLabel([
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "ultrafast" },
        { id: "mode", value: "yolo" },
      ]),
    ).toBe("xhigh · ultrafast");
    expect(
      usualOptionsLabel([
        { id: "reasoning_effort", value: "max" },
        { id: "serviceTier", value: "default" },
        { id: "workflow_mode", value: "off" },
      ]),
    ).toBe("max");
    expect(usualOptionsLabel([{ id: "fastMode", value: true }])).toBe("fast");
    expect(usualOptionsLabel([{ id: "fastMode", value: false }])).toBe("");
    expect(usualOptionsLabel(undefined)).toBe("");
  });
});
