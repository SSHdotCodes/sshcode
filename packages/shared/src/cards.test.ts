import { OrchestrationMessageContext } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCardReplyContext,
  CARD_LIMITS,
  cardFromToolItem,
  cardReplyUserBubbleText,
  formatCardInputsReply,
  initialCardInputValues,
  isShowCardToolCall,
  layoutChartXLabels,
  cardChartBar,
  cardChartRange,
  readCardReplyFromContext,
  resolveCardLockedState,
  snapSliderValue,
  statDeltaSentiment,
  trimCardText,
  validateAndNormalizeCardInput,
} from "./cards.ts";

describe("cards schema validation & limits", () => {
  it("validates a complete card with every block type, actions, and inputs", () => {
    const result = validateAndNormalizeCardInput({
      title: "Overnight build report",
      subtitle: "4 jobs checked across 2 repos",
      tone: "good",
      icon: "bot",
      blocks: [
        { text: "Everything passed except **one flaky test**." },
        {
          rows: [
            {
              title: "iOS build",
              detail: "Xcode 26",
              status: "done",
              chat: "thread-1",
              value: "2m 14s",
            },
            { title: "Server tests", status: "running", value: "48%" },
            { title: "Lint", status: "failed" },
            { title: "Deploy", status: "waiting" },
            { title: "Cleanup", status: "idle" },
          ],
        },
        {
          stats: [
            { label: "Passed", value: "412", delta: "+14" },
            { label: "Failed", value: "1", delta: "−2" },
            { label: "Duration", value: "3m 12s" },
          ],
        },
        { progress: { percent: 72, label: "Uploading artifacts", eta: "18s left" } },
        {
          chart: {
            kind: "line",
            series: [
              { label: "Latency (ms)", points: [120, 110, 95, 102] },
              { label: "P99", points: [240, 210, 195, 198] },
            ],
            xLabels: ["Mon", "Tue", "Wed", "Thu"],
          },
        },
        { image: { path: "shots/home.png", alt: "Home screen preview" } },
      ],
      actions: [
        { label: "Ship it", reply: "Go ahead and ship this build.", style: "primary" },
        { label: "Re-run flaky", reply: "Re-run the flaky test once.", style: "plain" },
        { label: "Abort", reply: "Abort the release.", style: "danger" },
      ],
      inputs: [
        {
          id: "env",
          kind: "choice",
          label: "Target",
          options: ["Staging", "Prod"],
          default: "Staging",
        },
        {
          id: "rollout",
          kind: "slider",
          label: "Rollout",
          min: 0,
          max: 100,
          step: 10,
          unit: "%",
          default: 25,
        },
        { id: "notify", kind: "toggle", label: "Notify team", default: true },
        { id: "note", kind: "text", label: "Release note", default: "Patch fix" },
      ],
      submit: "Deploy",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.tone).toBe("good");
    expect(result.card.blocks).toHaveLength(6);
    expect(result.card.actions).toHaveLength(3);
    expect(result.card.inputs).toHaveLength(4);
    expect(result.card.submit).toBe("Deploy");
  });

  it("enforces string and array limits by trimming with ellipsis and capping counts", () => {
    const longTitle = "A".repeat(120);
    const result = validateAndNormalizeCardInput({
      title: longTitle,
      subtitle: "B".repeat(200),
      blocks: Array.from({ length: 12 }, (_, i) => ({ text: `${i}: ${"x".repeat(700)}` })),
      actions: Array.from({ length: 6 }, (_, i) => ({
        label: `Action ${i} ${"z".repeat(40)}`,
        reply: "r".repeat(400),
      })),
      inputs: Array.from({ length: 9 }, (_, i) => ({
        id: `id-${i}`,
        kind: "text",
        label: `Field ${i} ${"l".repeat(60)}`,
      })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.card.title).length).toBe(CARD_LIMITS.title);
    expect(result.card.title.endsWith("…")).toBe(true);
    expect(Array.from(result.card.subtitle!).length).toBe(CARD_LIMITS.subtitle);
    expect(result.card.blocks).toHaveLength(CARD_LIMITS.maxBlocks);
    const firstBlock = result.card.blocks![0]!;
    expect("text" in firstBlock && Array.from(firstBlock.text).length).toBe(CARD_LIMITS.text);
    expect(result.card.actions).toHaveLength(CARD_LIMITS.maxActions);
    expect(result.card.inputs).toHaveLength(CARD_LIMITS.maxInputs);
  });

  it("returns short errors naming bad fields", () => {
    expect(validateAndNormalizeCardInput({})).toEqual({
      ok: false,
      error: "title: required non-empty string.",
    });
    expect(validateAndNormalizeCardInput({ title: "Hi", tone: "loud" })).toEqual({
      ok: false,
      error: "tone: expected one of neutral, good, warn, bad.",
    });
    expect(
      validateAndNormalizeCardInput({ title: "Hi", blocks: [{ text: "a", stats: [] }] }),
    ).toEqual({
      ok: false,
      error: "blocks[0]: must have exactly one of text, rows, stats, progress, chart, image.",
    });
    expect(
      validateAndNormalizeCardInput({
        title: "Hi",
        blocks: [{ progress: { percent: 150, label: "x" } }],
      }),
    ).toEqual({
      ok: false,
      error: "blocks[0].progress.percent: expected a number between 0 and 100.",
    });
    expect(
      validateAndNormalizeCardInput({
        title: "Hi",
        inputs: [{ id: "c", kind: "choice", label: "Pick" }],
      }),
    ).toEqual({
      ok: false,
      error: "inputs[0].options: choice input requires a non-empty string array.",
    });
    expect(
      validateAndNormalizeCardInput({
        title: "Hi",
        inputs: [{ id: "s", kind: "slider", label: "Level", min: 10, max: 5 }],
      }),
    ).toEqual({
      ok: false,
      error: "inputs[0].max: must be greater than min.",
    });
  });

  it("trims text cleanly with trimCardText", () => {
    expect(trimCardText("  hello  ", 10)).toBe("hello");
    expect(trimCardText("hello world", 6)).toBe("hello…");
  });

  it("caps input defaults and rejects oversized row.chat and image.path", () => {
    const ok = validateAndNormalizeCardInput({
      title: "Defaults",
      inputs: [
        { id: "note", kind: "text", label: "Note", default: "d".repeat(500) },
        {
          id: "pick",
          kind: "choice",
          label: "Pick",
          options: ["A"],
          default: "c".repeat(100),
        },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(Array.from(String(ok.card.inputs![0]!.default)).length).toBe(
        CARD_LIMITS.inputTextValue,
      );
      expect(Array.from(String(ok.card.inputs![1]!.default)).length).toBe(CARD_LIMITS.inputOption);
    }

    expect(
      validateAndNormalizeCardInput({
        title: "Long chat",
        blocks: [{ rows: [{ title: "Row", chat: "t".repeat(CARD_LIMITS.rowChat + 1) }] }],
      }),
    ).toEqual({
      ok: false,
      error: "blocks[0].rows[0].chat: exceeds maximum length.",
    });

    expect(
      validateAndNormalizeCardInput({
        title: "Long image",
        blocks: [{ image: { path: `${"a/".repeat(600)}img.png`, alt: "preview" } }],
      }),
    ).toEqual({
      ok: false,
      error: "blocks[0].image.path: exceeds maximum length.",
    });
  });
});

describe("tool-call detection and streaming state", () => {
  it("detects show_card with any MCP server prefix and deferred t3_tool dispatch", () => {
    for (const name of [
      "show_card",
      "mcp__t3-code__show_card",
      "mcp__other_server__show_card",
      "t3-code.show_card",
      "t3-code-thread_1_show_card",
      "custom:show_card",
    ]) {
      expect(isShowCardToolCall(name), name).toBe(true);
    }
    expect(isShowCardToolCall("other_tool")).toBe(false);
    expect(
      isShowCardToolCall("t3_tool", { name: "show_card", input: { title: "From deferred" } }),
    ).toBe(true);
    expect(isShowCardToolCall("t3_tool", { name: "show_card" })).toBe(false);
  });

  it("renders streaming skeleton while pending/running and ready card when completed", () => {
    expect(
      cardFromToolItem({
        toolName: "mcp__t3-code__show_card",
        status: "running",
        input: { title: "Loading stats" },
      }),
    ).toEqual({ state: "streaming", streamingTitle: "Loading stats" });

    const ready = cardFromToolItem({
      toolName: "mcp__t3-code__show_card",
      status: "completed",
      input: { title: "Done", blocks: [{ text: "All good" }] },
      output: { ok: true },
    });
    expect(ready?.state).toBe("ready");
    expect(ready?.card?.title).toBe("Done");

    expect(
      cardFromToolItem({
        toolName: "show_card",
        status: "completed",
        input: { title: "Failed" },
        output: { isError: true },
      }),
    ).toBeUndefined();

    // Serialized MCP failure outputs across provider shapes must not render a card.
    const serializedFailures: unknown[] = [
      JSON.stringify({ _tag: "OrchestratorMcpFailure", code: "invalid_request", message: "bad" }),
      [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", message: "bad" }) }],
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ _tag: "OrchestratorMcpFailure", message: "bad image" }),
          },
        ],
      },
      { ok: false, message: "rejected" },
    ];
    for (const output of serializedFailures) {
      expect(
        cardFromToolItem({
          toolName: "show_card",
          status: "completed",
          input: { title: "Rejected by server" },
          output,
        }),
      ).toBeUndefined();
    }

    // Valid MCP text-wrapped `{ ok: true }` still renders.
    expect(
      cardFromToolItem({
        toolName: "show_card",
        status: "completed",
        input: { title: "Accepted" },
        output: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
      })?.state,
    ).toBe("ready");
  });
});

describe("card replies, formatting, and locked state", () => {
  it("formats inputs into compact reply text and snaps sliders", () => {
    const card = validateAndNormalizeCardInput({
      title: "Tune settings",
      inputs: [
        {
          id: "mode",
          kind: "choice",
          label: "Mode",
          options: ["Fast", "Balanced"],
          default: "Balanced",
        },
        {
          id: "temp",
          kind: "slider",
          label: "Budget",
          min: 0,
          max: 100,
          step: 25,
          unit: "%",
          default: 37,
        },
        { id: "auto", kind: "toggle", label: "Auto-merge", default: true },
        { id: "msg", kind: "text", label: "Note", default: "Ship tonight" },
      ],
    });
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    const values = initialCardInputValues(card.card.inputs!);
    expect(values).toEqual({ mode: "Balanced", temp: 25, auto: true, msg: "Ship tonight" });
    expect(snapSliderValue(38, 0, 100, 25)).toBe(50);
    expect(snapSliderValue(0.00000031, 0, 0.000001, 1e-7)).toBe(0.0000003);
    expect(snapSliderValue(0.00000014, 0, 0.000001, 1.5e-7)).toBe(0.00000015);
    expect(snapSliderValue(1e-24, 0, 1e-23, 1e-25)).toBeCloseTo(1e-24, 30);
    expect(snapSliderValue(1.5, 0.5, 5.5, 1)).toBe(1.5);
    expect(formatCardInputsReply(card.card.inputs!, values)).toBe(
      "Mode: Balanced; Budget: 25%; Auto-merge: On; Note: Ship tonight",
    );
  });

  it("produces schema-valid card-reply context even with long labels, NaN values, or huge payloads", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationMessageContext);
    const withWeirdFields = buildCardReplyContext({
      itemId: "item:with:colons/and spaces",
      kind: "inputs",
      label: "L".repeat(300),
      actionIndex: Number.NaN,
      values: {
        bad: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        ok: 42,
        note: "x".repeat(500),
      },
    });
    const decoded = decode(withWeirdFields);
    const meta = readCardReplyFromContext(decoded);
    expect(meta?.itemId).toBe("item:with:colons/and spaces");
    expect(meta?.values).toEqual({ ok: 42, note: `${"x".repeat(299)}…` });
    expect(meta?.actionIndex).toBeUndefined();

    const blankLabel = decode(
      buildCardReplyContext({ itemId: "item-2", kind: "action", label: "   " }),
    );
    expect(blankLabel.records[0]?.label).toBe("Card reply");

    const hugeValues: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) hugeValues[`k${i}`] = "v".repeat(250);
    const oversized = decode(
      buildCardReplyContext({ itemId: "item-3", kind: "inputs", values: hugeValues }),
    );
    expect(readCardReplyFromContext(oversized)?.itemId).toBe("item-3");
  });

  it("round-trips hidden card-reply metadata and resolves locked state after reload", () => {
    const context = buildCardReplyContext({
      itemId: "item-42",
      kind: "action",
      actionIndex: 1,
      label: "Re-run",
    });
    expect(readCardReplyFromContext(context)).toEqual({
      itemId: "item-42",
      kind: "action",
      actionIndex: 1,
      label: "Re-run",
    });
    expect(cardReplyUserBubbleText({ text: "Please re-run the suite.", context })).toEqual({
      displayText: "Re-run",
      fromCard: true,
    });

    const parsed = validateAndNormalizeCardInput({
      title: "Tests failed",
      actions: [
        { label: "Ignore", reply: "Ignore it." },
        { label: "Re-run", reply: "Please re-run the suite.", style: "primary" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Unlocked before reply
    expect(resolveCardLockedState("item-42", parsed.card, [])).toEqual({ locked: false });

    // Locked by metadata
    expect(
      resolveCardLockedState("item-42", parsed.card, [
        { text: "Please re-run the suite.", context },
      ]),
    ).toEqual({
      locked: true,
      selectedActionIndex: 1,
      selectedActionLabel: "Re-run",
    });

    // Locked by text fallback (no metadata)
    expect(
      resolveCardLockedState("item-42", parsed.card, [{ text: "Please re-run the suite." }]),
    ).toEqual({
      locked: true,
      selectedActionIndex: 1,
      selectedActionLabel: "Re-run",
    });

    // Locked inert when user replied with unrelated text on a later turn
    expect(
      resolveCardLockedState("item-42", parsed.card, [
        { text: "Actually let's do something else" },
      ]),
    ).toEqual({ locked: true });

    // Messages the user didn't write (a routine firing, another chat's agent) leave it open
    expect(
      resolveCardLockedState("item-42", parsed.card, [
        { text: "Every morning, tell me what happened", createdBy: "agent" },
        { text: "Check the build", createdBy: "user", scheduledTaskId: "task-1" },
      ]),
    ).toEqual({ locked: false });
    expect(
      resolveCardLockedState("item-42", parsed.card, [
        { text: "Routine", createdBy: "agent" },
        { text: "Ignore it.", createdBy: "user" },
      ]),
    ).toEqual({ locked: true, selectedActionIndex: 0, selectedActionLabel: "Ignore" });
  });

  it("grows bars from zero, so a negative bar points down and a zero bar stays flat", () => {
    // Values -8..8 over a 100px plot: 0 sits at y=50.
    const yFor = (value: number) => 100 - ((value + 8) / 16) * 100;
    expect(cardChartBar(8, yFor)).toEqual({ y: 0, height: 50 });
    expect(cardChartBar(-8, yFor)).toEqual({ y: 50, height: 50 });
    expect(cardChartBar(-3, yFor)).toEqual({ y: 50, height: 18.75 });
    // A zero (or tiny) bar keeps a 2px sliver on the right side of zero.
    expect(cardChartBar(0, yFor)).toEqual({ y: 48, height: 2 });
    expect(cardChartBar(-0.01, yFor)).toEqual({ y: 50, height: 2 });
  });

  it("keeps zero on a bar chart's scale and fits it to the data", () => {
    expect(cardChartRange("bar", [-5, -12, -3])).toEqual({ min: -12, max: 0 });
    expect(cardChartRange("bar", [4, 9, 2])).toEqual({ min: 0, max: 9 });
    expect(cardChartRange("bar", [-3, 5, -8, 2])).toEqual({ min: -8, max: 5 });
    // Small values fill the plot instead of hugging zero.
    expect(cardChartRange("bar", [-0.002, -0.004])).toEqual({ min: -0.004, max: 0 });
    expect(cardChartRange("bar", [0.001, 0.004])).toEqual({ min: 0, max: 0.004 });
    expect(cardChartRange("bar", [0, 0])).toEqual({ min: 0, max: 1 });
    // Lines keep today's scale.
    expect(cardChartRange("line", [3, 5])).toEqual({ min: 0, max: 5 });
    expect(cardChartRange("line", [-4, -2])).toEqual({ min: -4, max: 1 });
  });

  it("fits short chart labels and evenly thins wider ones while keeping both endpoints", () => {
    const ticks = Array.from({ length: 7 }, (_, index) => ({
      center: 20 + index * 40,
      width: 25,
    }));
    expect(Array.from(layoutChartXLabels(ticks, 280))).toEqual([
      7.5, 47.5, 87.5, 127.5, 167.5, 207.5, 247.5,
    ]);
    expect(
      Array.from(
        layoutChartXLabels(
          ticks.map((tick) => ({ ...tick, width: 50 })),
          280,
        ),
      ),
    ).toEqual([0, undefined, 75, undefined, 155, undefined, 230]);
    expect(
      Array.from(
        layoutChartXLabels(
          [
            { center: 10, width: 24 },
            { center: 12, width: 24 },
          ],
          60,
        ),
      ),
    ).toEqual([0, 36]);
  });

  it("classifies stat deltas", () => {
    expect(statDeltaSentiment("+12%")).toBe("good");
    expect(statDeltaSentiment("−3%")).toBe("bad");
    expect(statDeltaSentiment("-5")).toBe("bad");
    expect(statDeltaSentiment("0")).toBe("neutral");
    // A stat's tone wins over the sign: lower latency is good.
    expect(statDeltaSentiment("−18ms", "good")).toBe("good");
    expect(statDeltaSentiment("+4", "bad")).toBe("bad");
    expect(statDeltaSentiment("+4", "neutral")).toBe("neutral");
  });

  it("keeps a stat's tone and rejects unknown ones", () => {
    const card = validateAndNormalizeCardInput({
      title: "Latency",
      blocks: [{ stats: [{ label: "P95", value: "84ms", delta: "−18ms", tone: "good" }] }],
    });
    expect(card.ok && card.card.blocks?.[0]).toEqual({
      stats: [{ label: "P95", value: "84ms", delta: "−18ms", tone: "good" }],
    });
    const bad = validateAndNormalizeCardInput({
      title: "Latency",
      blocks: [{ stats: [{ label: "P95", value: "84ms", tone: "warn" }] }],
    });
    expect(bad).toEqual({
      ok: false,
      error: "blocks[0].stats[0].tone: expected one of good, bad, neutral.",
    });
  });
});
