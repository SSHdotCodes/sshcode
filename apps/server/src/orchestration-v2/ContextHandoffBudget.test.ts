import { expandDebugCommand } from "@t3tools/shared/debugCommand";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  MAX_HANDOFF_TOKEN_CAP,
  contextUsageForHandoff,
  handoffBudget,
  renderHandoffWorkspace,
  scaledHandoffTokenCap,
  historyCost,
  historyResponseItems,
  renderHistory,
  selectHistory,
  handoffCoverage,
  handoffMessage,
  historicalMessage,
} from "@t3tools/provider-core/server/handoffBudget";
import { projectContextHandoffForWire } from "./WireProjection.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { nativeContextState } from "./nativeContextState.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHandoff = Schema.decodeUnknownSync(OrchestrationV2ContextHandoff);

const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
const threadId = ThreadId.make("thread:handoff");
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:target"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    strength: "strong",
    nativeId: "native:target",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2HistoricalMessage => ({
  itemId: TurnItemId.make(id),
  role,
  text,
  threadId,
  runId: RunId.make("run:source"),
  providerThreadId: ProviderThreadId.make("provider-thread:source"),
  status: "interrupted",
  kind: role === "user" ? "user_message" : "assistant_message",
});
const messages = [
  message("item:one", "user", "Preserve every line.\n\n  And this indentation.\n"),
  message("item:two", "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];
const handoff: OrchestrationV2ContextHandoff = {
  id: ContextHandoffId.make("handoff:one"),
  threadId,
  targetRunId: RunId.make("run:target"),
  fromProviderThreadIds: [],
  toProviderThreadId: providerThread.id,
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "",
  history: {
    messages,
    coverage: "Historical context; retrieve thread:handoff with t3_thread_read.",
    omittedItems: 0,
  },
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
};

describe("handoff budget", () => {
  it("keeps old preview handoffs readable and delivery history off the wire", () => {
    const projected = projectContextHandoffForWire({
      ...handoff,
      summaryText: "private transcript and command output",
      delivery: {
        nativeThreadId: "native:target",
        status: "injected",
        itemIds: [messages[0]!.itemId],
      },
    });
    assert.equal(projected.summaryText, "");
    assert.isUndefined(projected.history);
    assert.isUndefined(projected.delivery);
    assert.equal(decodeHandoff(projected).id, handoff.id);
    assert.deepEqual(handoff.history?.messages, messages);
  });
  it("carries command outcomes as attributed activity and excludes reasoning", () => {
    const base = {
      id: TurnItemId.make("item:command"),
      threadId,
      runId: RunId.make("run:source"),
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const command = historicalMessage({
      ...base,
      type: "command_execution",
      input: "vp test",
      output: "Failure near the end: " + "界".repeat(300),
      exitCode: 1,
    });
    const debug = expandDebugCommand("/debug stale phone");
    const user = historicalMessage({
      ...base,
      type: "user_message",
      messageId: MessageId.make("debug-history"),
      ...debug,
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    });
    assert.include(user!.text, "Reproduce it now, then pick Done");
    assert.equal(user!.text.match(/Debug workflow:/g)?.length, 1);
    assert.isAbove(
      historyCost([user!], "History"),
      historyCost([{ ...user!, text: debug.text }], "History"),
    );
    const selectedDebug = selectHistory({ messages: [user!], coverage: "History", budget: 16_000 });
    assert.deepEqual(selectedDebug.messages, [user]);
    assert.equal(command?.role, "assistant");
    assert.equal(command?.kind, "command_execution");
    assert.include(command!.text, "Exit code: 1");
    assert.include(command!.text, "界".repeat(300));
    assert.isNull(
      historicalMessage({
        ...base,
        type: "reasoning",
        text: "private reasoning",
        streaming: false,
      }),
    );
    assert.equal(historyResponseItems([command!], "Activity")[1]?.type, "message");
  });

  it("shares consecutive source lines and names an item only when its text was cut", () => {
    const first = message("item:1", "user", "first\n  exact body");
    const second = { ...message("item:2", "assistant", "second"), status: "completed" as const };
    const other = {
      ...message("item:3", "assistant", "third"),
      runId: RunId.make("other-run"),
      runStatus: "failed" as const,
    };
    const cut = { ...first, itemId: TurnItemId.make("item:4"), shortened: true as const };
    const candidates = [first, second, other, cut];
    const native = historyResponseItems(candidates, "coverage");
    const text = renderHistory(candidates, "coverage");
    // The first two share a source, the third ran elsewhere, the fourth is back on the first.
    assert.equal(text.match(/Historical source:/g)?.length, 3);
    assert.include(native[1]!.content[0]!.text, "[Historical user; user_message; interrupted]\n");
    assert.include(native[2]!.content[0]!.text, "[Historical assistant; assistant_message]\n");
    assert.include(native[3]!.content[0]!.text, "run-status=failed");
    assert.include(native[4]!.content[0]!.text, "; item=item:4]\n");
    assert.notInclude(text, "item=item:1");
    assert.notInclude(text, "provider-thread=");
    for (const [index, item] of candidates.entries()) {
      const delivered = native[index + 1]!.content[0]!.text;
      assert.isTrue(delivered.endsWith(item.text));
      assert.include(text, delivered);
      assert.equal(native[index + 1]!.role, item.role);
    }
    const hundred = Array.from({ length: 100 }, (_, index) =>
      message(`item:${index}`, "assistant", "body"),
    );
    assert.equal(renderHistory(hundred, "coverage").match(/Historical source:/g)?.length, 1);
    assert.isBelow(renderHistory(hundred, "coverage").length, 7_000);
  });

  it("retains short conversations verbatim in role and order", () => {
    const selected = selectHistory({ messages, coverage: "History", budget: 16_000 });
    assert.deepEqual(selected.messages, messages);
    const items = historyResponseItems(selected.messages, selected.context);
    assert.deepEqual(
      items.map((item) => item.role),
      ["user", "user", "assistant"],
    );
    assert.include(items[1]!.content[0]!.text, messages[0]!.text);
    assert.include(items[2]!.content[0]!.text, messages[1]!.text);
    assert.equal(selected.omittedItems, 0);
  });

  it("shortens oversized items instead of dropping them, original constraints and recent work first", () => {
    const candidates = [
      messages[0]!,
      message("huge", "assistant", "界🧪".repeat(20_000)),
      message("old", "assistant", "a".repeat(9_000)),
      messages[1]!,
    ];
    const selected = selectHistory({
      messages: candidates,
      coverage: "thread:handoff runs 1-4",
      budget: 12_000,
    });
    // The first request and the latest answer arrive word for word, as the same objects.
    assert.strictEqual(selected.messages[0], messages[0]);
    assert.strictEqual(selected.messages.at(-1), messages[1]);
    const old = selected.messages.find((item) => item.itemId === "old");
    assert.isTrue(old?.shortened);
    assert.match(old!.text, /^a+\n\[… \d+ characters cut\]\na+$/u);
    const huge = selected.messages.find((item) => item.itemId === "huge");
    assert.isTrue(huge?.shortened);
    // A cut never leaves half of an emoji behind.
    assert.equal(Buffer.from(huge!.text).toString(), huge!.text);
    assert.notMatch(
      huge!.text,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    assert.include(selected.context, "Selected 4 items (2 shortened");
    assert.equal(selected.omittedItems, 0);
    assert.isAtMost(historyCost(selected.messages, selected.context), 12_000);

    const tight = selectHistory({
      messages: candidates,
      coverage: "thread:handoff runs 1-4",
      budget: 2_000,
    });
    assert.include(tight.messages, messages[0]);
    assert.include(tight.messages, messages[1]);
    assert.deepEqual(tight.omittedItemIds, ["huge", "old"]);
    assert.isAtMost(historyCost(tight.messages, tight.context), 2_000);
  });

  it("keeps the first request, the latest answer and the latest request in some form whenever their trails fit", () => {
    const candidates = [
      message("first-user", "user", "F".repeat(40_000) + "FIRST-TAIL"),
      message("latest-answer", "assistant", "A".repeat(40_000) + "ANSWER-TAIL"),
      message("latest-user", "user", "L".repeat(40_000) + "LATEST-TAIL"),
    ];
    // At 10,000 the capped latest request alone used to starve the other two, and at
    // 16,000 the capped latest pair used to starve the first request.
    for (const budget of [6_000, 10_000, 16_000]) {
      const selected = selectHistory({ messages: candidates, coverage: "runs 1-3", budget });
      assert.deepEqual(selected.omittedItemIds, []);
      for (const tail of ["FIRST-TAIL", "ANSWER-TAIL", "LATEST-TAIL"])
        assert.isTrue(
          selected.messages.some((item) => item.text.endsWith(tail)),
          `budget ${budget} keeps ${tail}`,
        );
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
    }
  });

  it("keeps every request and the model's findings when commands printed a lot", () => {
    const command = (id: string, output: string, exitCode = 0) => ({
      ...message(id, "assistant", `Command: run ${id}\nExit code: ${exitCode}\n${output}`),
      kind: "command_execution",
      status: exitCode === 0 ? "completed" : "failed",
    });
    const candidates = [
      message("ask", "user", "Make the cube quieter."),
      command("find", "path\n".repeat(8_000)),
      message("note", "assistant", "Found the v14 source."),
      message("also", "user", "and keep supports minimal"),
      command("list", "file\n".repeat(3_000)),
      {
        ...message(
          "review",
          "assistant",
          `Subagent: Review (codex)\nTask: review the hinge\nResult: ${"finding ".repeat(900)}use a softer stop.`,
        ),
        kind: "subagent",
      },
      command("slice", `${"layer\n".repeat(2_000)}error: thin wall at layer 12`, 1),
      command("check", "ok"),
      message("go", "user", "continue"),
    ];
    const selected = selectHistory({ messages: candidates, coverage: "runs 1-2", budget: 16_000 });
    const text = renderHistory(selected.messages, selected.context);
    // Nothing is dropped: the old selection lost "also", "note" and the review here.
    assert.equal(selected.omittedItems, 0);
    for (const kept of ["ask", "note", "also", "go"])
      assert.strictEqual(
        selected.messages.find((item) => item.itemId === kept),
        candidates.find((item) => item.itemId === kept),
      );
    assert.include(text, "use a softer stop.");
    assert.include(text, "Command: run find\nExit code: 0\n");
    assert.include(text, "error: thin wall at layer 12");
    // Shortened items name themselves so the rest can be read; intact ones do not.
    assert.include(text, "[Historical assistant; command_execution; item=find]");
    assert.include(text, "[Historical assistant; command_execution; failed; item=slice]");
    assert.include(text, "[Historical assistant; command_execution]\nCommand: run check");
    assert.isAtMost(historyCost(selected.messages, selected.context), 16_000);

    // With little room the trail still says what ran and how it ended; a failure keeps its
    // last lines, a success keeps no output.
    const tight = selectHistory({ messages: candidates, coverage: "runs 1-2", budget: 3_200 });
    const trail = renderHistory(tight.messages, tight.context);
    for (const kept of ["ask", "also", "go"])
      assert.include(
        tight.messages.map((item) => item.itemId),
        kept,
      );
    assert.include(trail, "error: thin wall at layer 12");
    assert.notInclude(trail, "path\npath");
    assert.isAtMost(historyCost(tight.messages, tight.context), 3_200);
  });

  it("carries subagent results, searches and app tool calls, not repeated subagent rows", () => {
    const base = {
      id: TurnItemId.make("item:extra"),
      threadId,
      runId: RunId.make("run:source"),
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: "Review the hinge",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const subagent = {
      ...base,
      type: "subagent" as const,
      subagentId: "node:child" as never,
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Look at the stops.",
      result: "Use a softer stop.",
    };
    const carried = handoffMessage(subagent);
    assert.equal(carried?.kind, "subagent");
    assert.equal(
      carried?.text,
      "Subagent: Review the hinge (codex)\nTask: Look at the stops.\nResult: Use a softer stop.",
    );
    assert.isNull(handoffMessage({ ...subagent, promptOmitted: true, resultOmitted: true }));
    assert.equal(
      handoffMessage({ ...base, type: "web_search", patterns: ["quiet hinge", "tpu stop"] })?.text,
      "Web search: quiet hinge | tpu stop",
    );
    assert.isNull(handoffMessage({ ...base, type: "web_search" }));
    assert.equal(
      handoffMessage({
        ...base,
        type: "dynamic_tool",
        toolName: "t3-code.ask_user" as never,
        input: { question: "Which printer?" },
        output: { answer: "The small one" },
      })?.text,
      'Tool: t3-code.ask_user\nInput: {"question":"Which printer?"}\nOutput: {"answer":"The small one"}',
    );
    // The native-context estimate keeps counting transcript kinds only.
    assert.isNull(historicalMessage(subagent));
    assert.isNull(
      handoffMessage({ ...base, type: "reasoning", text: "private", streaming: false }),
    );
  });

  it("keeps a tool call's input and output ends when its stored shortened copy is shortened again at delivery", () => {
    const tool = {
      ...message(
        "dyn",
        "assistant",
        `Tool: probe.tool\nInput: {"q":"${"i".repeat(5_000)}INPUT-TAIL"}\nOutput: {"r":"${"o".repeat(5_000)}OUTPUT-TAIL"}`,
      ),
      kind: "dynamic_tool",
    };
    const first = selectHistory({ messages: [tool], coverage: "cov", budget: 4_000 }).messages[0]!;
    assert.isTrue(first.shortened);
    assert.include(first.text, "INPUT-TAIL");
    assert.include(first.text, "OUTPUT-TAIL");
    // Delivery re-runs the selection over the stored copy under its own, tighter
    // budget, and stored copies outlive the clip sizes that produced them. A stored
    // copy's cuts put marker lines inside the Input and Output segments; reading only
    // the first three lines mistook the input's cut marker for the output and
    // dropped the real output and both tails.
    const stored = {
      ...tool,
      text: [
        "Tool: probe.tool",
        `Input: {"q":"${"i".repeat(600)}`,
        "[… 4000 characters cut]",
        `${"j".repeat(600)}INPUT-TAIL"}`,
        `Output: {"r":"${"o".repeat(600)}`,
        "[… 4000 characters cut]",
        `${"p".repeat(900)}OUTPUT-TAIL"}`,
      ].join("\n"),
      shortened: true as const,
    };
    const delivered = selectHistory({ messages: [stored], coverage: "cov", budget: 2_200 })
      .messages[0]!;
    assert.include(delivered.text, "INPUT-TAIL");
    assert.include(delivered.text, "Output:");
    assert.include(delivered.text, "OUTPUT-TAIL");
  });

  it("stays inside any budget with mixed kinds and sizes", () => {
    const kinds = [
      "user_message",
      "assistant_message",
      "command_execution",
      "dynamic_tool",
      "error",
    ];
    const candidates = Array.from({ length: 240 }, (_, index) => {
      const kind = kinds[index % kinds.length]!;
      const body = `${'界🧪x"\n'.repeat((index * 37) % 900)}end ${index}`;
      return {
        ...message(
          `mixed:${index}`,
          kind === "user_message" ? "user" : "assistant",
          kind === "command_execution"
            ? `Command: step ${index}\nExit code: ${index % 3}\n${body}`
            : body,
        ),
        kind,
        status: index % 7 === 0 ? "failed" : "completed",
        runId: RunId.make(`run:${index % 5}`),
      };
    });
    for (const budget of [0, 300, 1_024, 2_500, 7_777, 16_000, 32_000, 64_000]) {
      const selected = selectHistory({ messages: candidates, coverage: "Recover history", budget });
      if (selected.messages.length > 0)
        assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      assert.equal(selected.messages.length + selected.omittedItemIds.length, candidates.length);
      assert.equal(selected.omittedItems, selected.omittedItemIds.length);
      // Chat order is kept.
      const positions = selected.messages.map((item) => Number(item.itemId.split(":")[1]));
      assert.deepEqual(
        positions,
        [...positions].sort((a, b) => a - b),
      );
    }
  });

  it("points history recovery at the omitted items instead of a read from the thread's start", () => {
    const selected = selectHistory({
      messages: [
        messages[0]!,
        ...Array.from({ length: 60 }, (_, i) =>
          message(`item:omitted-${i}`, "assistant", "o".repeat(400)),
        ),
        ...Array.from({ length: 3 }, (_, i) => message(`item:recent-${i}`, "assistant", "recent")),
      ],
      coverage: handoffCoverage({ threadId, coveredRunOrdinals: { from: 1, to: 46 }, items: [] }),
      budget: 3_000,
    });
    assert.isAbove(selected.omittedItems, 0);
    assert.include(selected.context, 'query:"<words>"');
    assert.include(selected.context, "read it by itemId");
    assert.notInclude(selected.context, "afterPosition");
    assert.notInclude(selected.context, "limit:20");
    assert.isAtMost(historyCost(selected.messages, selected.context), 3_000);
  });

  it("counts JSON escaping and UTF-8 bytes across many messages", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      message(`item:${i}`, i % 2 ? "assistant" : "user", '\u0000\\"🧪界'.repeat(15)),
    );
    for (const budget of [1_024, 4_000, 16_000]) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Retrieve omitted history",
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      assert.isAbove(selected.omittedItems, 0);
    }
  });

  it("fits the final envelope at intermediate selected/omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      message(`boundary:${index}`, "user", "Short request"),
    );
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Recover history",
        omittedItems: 90,
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
    }
  });

  it("selects a lone item at the exact budget its delivered form costs", () => {
    const coverage = handoffCoverage({
      threadId,
      coveredRunOrdinals: { from: 1, to: 3 },
      items: [],
    });
    const single = [message("only-user", "user", "Please continue the task exactly as specified.")];
    const full = selectHistory({ messages: single, coverage, budget: 16_000 });
    const exact = historyCost(full.messages, full.context);
    const selected = selectHistory({ messages: single, coverage, budget: exact });
    assert.deepEqual(selected.messages, single);
    assert.isAtMost(historyCost(selected.messages, selected.context), exact);
  });

  it("subtracts native usage, input, attachments, instructions and space for work", () => {
    const base = {
      tokenCap: 16_000,
      userText: "Continue",
      attachments: [],
      providerThread,
      nativeContextEstimate: 0,
      modelContextWindow: 32_000,
    };
    assert.isBelow(handoffBudget(base), 16_000);
    assert.isBelow(handoffBudget({ ...base, nativeContextEstimate: 8_000 }), handoffBudget(base));
    assert.equal(handoffBudget({ ...base, userText: "界".repeat(30_000) }), 0);
    assert.equal(
      handoffBudget({
        ...base,
        providerThread: {
          ...providerThread,
          contextUsage: { usedTokens: 23_000, maxTokens: 24_000 },
        },
      }),
      0,
    );
    for (const sizeBytes of [100_000, 10 * 1024 * 1024]) {
      const attachments = [
        {
          type: "image",
          id: "attachment",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes,
        },
      ];
      const withImage = handoffBudget({ ...base, attachments });
      assert.isAbove(withImage, 4_000);
      assert.isBelow(withImage, handoffBudget(base));
      assert.equal(handoffBudget({ ...base, attachments: [...attachments, ...attachments] }), 0);
      assert.equal(
        handoffBudget({
          ...base,
          tokenCap: 64_000,
          modelContextWindow: 1_000_000,
          // The history byte cap is independent of both current text and image payloads.
          userText: "x".repeat(70_000),
          attachments,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000 },
          },
        }),
        64_000,
      );
    }
    assert.equal(handoffBudget({ ...base, tokenCap: 2_000 }), 2_000);
  });

  it("keeps measured occupancy across a model change", () => {
    const previous = {
      usedTokens: 37_321,
      maxTokens: 258_400,
      autoCompactThreshold: 32_000,
    };
    assert.isNull(
      contextUsageForHandoff({
        sameNativeThread: false,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
    );
    assert.equal(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      previous,
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: { usedTokens: 30_000, maxTokens: 32_000, autoCompactThreshold: 31_000 },
        knownModelWindow: 1_000_000,
      }),
      { usedTokens: 30_000, maxTokens: 1_000_000 },
    );

    const preserved = contextUsageForHandoff({
      sameNativeThread: true,
      sameSelection: false,
      reuseTelemetry: false,
      previousUsage: previous,
    });
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [
          {
            type: "image",
            id: "screenshot-a",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
          {
            type: "image",
            id: "screenshot-b",
            name: "b.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
        ],
        providerThread: { ...providerThread, contextUsage: preserved },
        nativeContextEstimate: 0,
        modelContextWindow: preserved?.maxTokens,
      }),
      16_000,
    );
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [],
        providerThread,
        nativeContextEstimate: 120_000,
      }),
      0,
    );
  });
  it("reserves context for image batches up to the attachment limit, honoring smaller known windows", () => {
    let previousBudget = 16_000;
    for (let count = 1; count <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; count++) {
      const input = {
        tokenCap: 16_000,
        userText: "Compare these screenshots",
        providerThread,
        nativeContextEstimate: 0,
        attachments: Array.from({ length: count }, (_, index) => ({
          type: "image",
          id: `image-${index}`,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 100_000,
        })),
      };
      const budget = handoffBudget(input);
      assert.isAtLeast(budget, 0);
      assert.isAtMost(budget, previousBudget);
      previousBudget = budget;
      if (count <= 8) assert.equal(budget, 16_000);
      if (count === 10) {
        assert.isAbove(budget, 0);
        assert.isBelow(budget, 16_000);
      }
      if (count === PROVIDER_SEND_TURN_MAX_ATTACHMENTS) assert.equal(budget, 0);
      if (budget > 0) {
        const selected = selectHistory({ messages, coverage: "Recover omitted history", budget });
        assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      }
      assert.equal(handoffBudget({ ...input, modelContextWindow: 2_000_000 }), 16_000);
      assert.equal(handoffBudget({ ...input, modelContextWindow: 20_000 }), 0);
      assert.equal(
        handoffBudget({
          ...input,
          providerThread: { ...providerThread, contextUsage: { usedTokens: 0, maxTokens: 20_000 } },
        }),
        0,
      );
      assert.equal(
        handoffBudget({
          ...input,
          modelContextWindow: 1_000_000,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000, autoCompactThreshold: 20_000 },
          },
        }),
        0,
      );
    }
  });
});

describe("handoff delivery", () => {
  it.effect.each([
    { native: true, label: "injected" },
    { native: false, label: "inline" },
  ])("records omitted recovery coverage separately from $label text", ({ native }) =>
    Effect.gen(function* () {
      const omittedBeforeDelivery = TurnItemId.make("item:omitted-during-preparation");
      // Too large for this budget even shortened.
      const oversized = message("item:oversized", "user", "x".repeat(20_000));
      let durable: OrchestrationV2ContextHandoff = {
        ...handoff,
        history: {
          ...handoff.history!,
          messages: [...messages, oversized],
          omittedItems: 1,
          omittedItemIds: [omittedBeforeDelivery],
        },
      };
      const result = yield* deliverContextHandoffs({
        handoffs: [durable],
        providerThread,
        budget: 2_200,
        alreadyDeliveredItemIds: new Set(),
        inject: (value) => {
          assert.include(value.context, "omitted 2 items");
          assert.notInclude(
            value.messages.map((item) => item.itemId),
            oversized.itemId,
          );
          return Effect.succeed(native);
        },
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }),
      });
      assert.equal(durable.delivery?.status, native ? "injected" : "pending");
      yield* result.delivered;
      assert.equal(durable.delivery?.status, native ? "injected" : "inline");
      assert.deepEqual(
        durable.delivery?.itemIds,
        messages.map((item) => item.itemId),
      );
      assert.deepEqual(durable.delivery?.omittedItemIds, [omittedBeforeDelivery, oversized.itemId]);
      assert.deepEqual(decodeHandoff(durable).delivery, durable.delivery);
    }),
  );
  it.effect("counts a delivered item at the size delivery actually sent, not the stored size", () =>
    Effect.gen(function* () {
      const bigText = "U".repeat(30_000);
      // Stored at preparation in capped form, then shortened again by delivery's
      // tighter budget. The native estimate reads the persisted history, so what
      // delivery shortened has to be what delivery persists.
      const stored = selectHistory({
        messages: [message("item:big", "user", bigText)],
        coverage: "cov",
        budget: 16_000,
      }).messages[0]!;
      const omitted = TurnItemId.make("item:discarded-on-replacement");
      let durable: OrchestrationV2ContextHandoff = {
        ...handoff,
        fromProviderThreadIds: [providerThread.id],
        history: {
          ...handoff.history!,
          messages: [stored],
          omittedItems: 1,
          omittedItemIds: [omitted],
        },
      };
      let injectedText = "";
      yield* deliverContextHandoffs({
        handoffs: [durable],
        providerThread,
        budget: 3_000,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            injectedText = history.messages[0]?.text ?? "";
            return true;
          }),
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }),
      });
      assert.isBelow(injectedText.length, stored.text.length);
      const state = nativeContextState({
        projection: { runs: [], attempts: [], providerTurns: [], contextHandoffs: [durable] },
        providerThread,
        run: {
          id: RunId.make("run:next"),
          threadId,
          ordinal: 9,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          providerThreadId: providerThread.id,
          userMessageId: MessageId.make("message:next"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
        nativeThreadId: "native:target",
      });
      const original = {
        id: TurnItemId.make("item:big"),
        threadId,
        runId: RunId.make("run:source"),
        nodeId: null,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: MessageId.make("message:big"),
        text: bigText,
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      } as const;
      const estimate = state.estimateHistory([original, { ...original, id: omitted }]);
      assert.equal(estimate, Buffer.byteLength(injectedText));
    }),
  );
  it.effect("loads the history budget only when a handoff needs delivery", () =>
    Effect.gen(function* () {
      let reads = 0;
      const input = {
        providerThread,
        budget: Effect.sync(() => {
          reads++;
          return 16_000;
        }),
        alreadyDeliveredItemIds: new Set<string>(),
        persist: () => Effect.void,
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [] });
      yield* deliverContextHandoffs({ ...input, handoffs: [handoff], deferInline: true });
      yield* deliverContextHandoffs({
        ...input,
        handoffs: [
          {
            ...handoff,
            delivery: {
              nativeThreadId: providerThread.nativeThreadRef!.nativeId!,
              status: "injected",
              itemIds: [],
            },
          },
        ],
      });
      assert.equal(reads, 0);
      const result = yield* deliverContextHandoffs({ ...input, handoffs: [handoff] });
      assert.equal(reads, 1);
      assert.include(result.context, messages[0]!.text);
    }),
  );

  it.effect("persists successful injection before turn start and skips it on retry", () =>
    Effect.gen(function* () {
      let durable = handoff;
      const history: unknown[] = [];
      const statuses: string[] = [];
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (value: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
          Effect.sync(() => {
            history.push(...historyResponseItems(value.messages, value.context));
            return true;
          }),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
            statuses.push(value.delivery!.status);
          }),
      };
      const first = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(first.context, "");
      assert.deepEqual(statuses, ["pending", "injected"]);
      assert.lengthOf(history, 3);
      // No turn has started. Reconstruct from the durable projection as a retry would.
      const second = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(second.context, "");
      assert.lengthOf(history, 3);
    }),
  );

  it.effect(
    "uses the same selection on explicit native fallback, marking only accepted input",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const result = yield* deliverContextHandoffs({
          handoffs: [handoff],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist: (value) =>
            Effect.sync(() => {
              durable = value;
            }),
        });
        assert.include(result.context, messages[0]!.text);
        assert.include(result.context, messages[1]!.text);
        assert.equal(durable.delivery?.status, "pending");
        yield* result.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect(
    "defers unsupported compaction history until a normal turn without marking delivery uncertain",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const persist = (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          });
        const compact = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          deferInline: true,
          inject: () => Effect.succeed(false),
          persist,
        });
        yield* compact.delivered;
        assert.equal(compact.context, "");
        assert.isUndefined((() => durable.delivery)());
        const next = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist,
        });
        assert.include(next.context, messages[0]!.text);
        yield* next.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect("bounds accumulated recovery markers while keeping omitted history discoverable", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 100 }, (_, index) => ({
        ...handoff,
        id: ContextHandoffId.make(`handoff:retry:${index}`),
      }));
      let captured: ProviderAdapter.ProviderAdapterV2HistoricalContext | undefined;
      const result = yield* deliverContextHandoffs({
        handoffs: many,
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            captured = history;
            return true;
          }),
        persist: () => Effect.void,
      });
      assert.equal(result.context, "");
      assert.isDefined(captured);
      assert.include(captured.context, "detailed coverage references omitted");
      assert.include(captured.context, "t3_thread_read");
      assert.include(captured.context, threadId);
      assert.isAtMost(historyCost(captured.messages, captured.context), 2_500);
      assert.isAbove(captured.messages.length, 0);
    }),
  );

  it.effect("does not redeliver after ambiguous injection failure", () =>
    Effect.gen(function* () {
      let durable = handoff;
      let calls = 0;
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(Effect.fail("connection lost"))),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          }),
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(Effect.result);
      assert.equal(durable.delivery?.status, "pending");
      const retry = yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(
        Effect.result,
      );
      assert.equal(retry._tag, "Failure");
      assert.equal(calls, 1);
    }),
  );

  it.effect("budgets multiple handoffs together and skips previously delivered items", () =>
    Effect.gen(function* () {
      const extra = {
        ...handoff,
        id: ContextHandoffId.make("handoff:two"),
        history: {
          ...handoff.history!,
          messages: [...messages, message("item:three", "assistant", "Latest result")],
        },
      };
      let delivered: ReadonlyArray<unknown> = [];
      yield* deliverContextHandoffs({
        handoffs: [handoff, extra],
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(["item:one"]),
        inject: (value) =>
          Effect.sync(() => {
            delivered = historyResponseItems(value.messages, value.context);
            return true;
          }),
        persist: () => Effect.void,
      });
      const serialized = yield* encodeJson(delivered);
      assert.isAtMost(Buffer.byteLength(serialized), 2_500);
      assert.notInclude(serialized, "Preserve every line");
      assert.equal(serialized.split("Partial work").length - 1, 1);
      assert.include(serialized, "Latest result");
    }),
  );

  it.effect("keeps the fullest stored copy when pending handoffs carry the same item", () =>
    Effect.gen(function* () {
      const shared = message("item:shared", "user", "S".repeat(20_000));
      const trail = selectHistory({ messages: [shared], coverage: "cov", budget: 3_000 })
        .messages[0]!;
      const fuller = selectHistory({ messages: [shared], coverage: "cov", budget: 16_000 })
        .messages[0]!;
      assert.isBelow(trail.text.length, fuller.text.length);
      const withCopy = (id: string, copy: typeof trail): OrchestrationV2ContextHandoff => ({
        ...handoff,
        id: ContextHandoffId.make(id),
        history: { ...handoff.history!, messages: [copy], omittedItems: 0, omittedItemIds: [] },
      });
      let deliveredText = "";
      yield* deliverContextHandoffs({
        handoffs: [withCopy("handoff:trail", trail), withCopy("handoff:fuller", fuller)],
        providerThread,
        budget: 32_000,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            deliveredText = history.messages[0]?.text ?? "";
            return true;
          }),
        persist: () => Effect.void,
      });
      assert.equal(deliveredText, fuller.text);
    }),
  );

  it.effect("fails before delivery when even the coverage marker cannot fit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 0,
        alreadyDeliveredItemIds: new Set(),
        inject: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
        persist: () => Effect.void,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(calls, 0);
    }),
  );
});

describe("handoff size and brief", () => {
  const brief = {
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    text: `## Goal and requirements\nShip the importer.\n${"Detail. ".repeat(80)}`,
  };

  it("scales with the target's window between the floor and the ceiling", () => {
    assert.equal(scaledHandoffTokenCap(undefined), 51_200);
    assert.equal(scaledHandoffTokenCap(32_000), DEFAULT_HANDOFF_TOKEN_CAP);
    assert.equal(scaledHandoffTokenCap(200_000), 80_000);
    assert.equal(scaledHandoffTokenCap(1_048_576), MAX_HANDOFF_TOKEN_CAP);
  });

  it("carries more of a long chat whole to a model with a larger window", () => {
    const longChat = Array.from({ length: 400 }, (_, index) =>
      index % 4 === 0
        ? message(`item:${index}`, "user", `Request ${index}: ${"keep this ".repeat(40)}`)
        : {
            ...message(
              `item:${index}`,
              "assistant",
              `Command output ${index}\n${"line\n".repeat(400)}`,
            ),
            kind: "command_execution",
            text: `Command: run ${index}\nExit code: 0\n${"line\n".repeat(400)}`,
          },
    );
    const select = (window: number) =>
      selectHistory({
        messages: longChat,
        coverage: "coverage",
        budget: scaledHandoffTokenCap(window),
      });
    const small = select(128_000);
    const large = select(1_000_000);
    const whole = (selected: ReturnType<typeof select>) =>
      selected.messages.filter((candidate) => candidate.shortened !== true).length;
    assert.isAbove(whole(large), whole(small));
    assert.isBelow(large.omittedItems, small.omittedItems);
    // The ranking is unchanged, and the larger size reaches every request.
    const requests = (selected: ReturnType<typeof select>) =>
      selected.messages.filter((candidate) => candidate.kind === "user_message").length;
    assert.equal(requests(large), 100);
    assert.isAbove(requests(small), 60);
  });

  it.effect(
    "puts the previous model's brief and the workspace ahead of the history, within the budget",
    () =>
      Effect.gen(function* () {
        const persisted: OrchestrationV2ContextHandoff[] = [];
        const workspace = renderHandoffWorkspace({
          branch: "feature/import",
          worktreePath: "/work",
        });
        const budget = 16_000;
        const result = yield* deliverContextHandoffs({
          handoffs: [handoff],
          providerThread,
          budget,
          brief,
          workspace,
          alreadyDeliveredItemIds: new Set(),
          persist: (value) => Effect.sync(() => void persisted.push(value)),
        });
        assert.isTrue(result.briefIncluded);
        const briefAt = result.context.indexOf(
          "[Handoff brief from the previous model, claude-opus-5-5",
        );
        const workspaceAt = result.context.indexOf("[Workspace at handoff]");
        const coverageAt = result.context.indexOf("Context handoff (full_thread_summary)");
        const historyAt = result.context.indexOf(messages[0]!.text);
        assert.equal(briefAt, 0);
        assert.isTrue(briefAt < workspaceAt && workspaceAt < coverageAt && coverageAt < historyAt);
        assert.isAtMost(Buffer.byteLength(JSON.stringify(result.context)), budget);
        // The brief is kept for a repeated delivery, and never sent to clients.
        assert.equal(persisted.at(-1)?.brief?.text, brief.text);
        assert.equal(projectContextHandoffForWire(persisted.at(-1)!).brief?.text, "");
        const again = yield* deliverContextHandoffs({
          handoffs: [persisted.at(-1)!],
          providerThread: { ...providerThread, nativeThreadRef: null },
          budget,
          alreadyDeliveredItemIds: new Set(),
          persist: () => Effect.void,
        });
        assert.isTrue(again.briefIncluded);
        assert.include(again.context, "Ship the importer.");
      }),
  );

  it.effect("leaves out a brief that would crowd out the history, and still delivers", () =>
    Effect.gen(function* () {
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 2_000,
        brief,
        alreadyDeliveredItemIds: new Set(),
        persist: () => Effect.void,
      });
      assert.isFalse(result.briefIncluded);
      assert.notInclude(result.context, "Handoff brief");
      assert.include(result.context, "Context handoff (full_thread_summary)");
    }),
  );

  it("describes the workspace in a few bounded lines", () => {
    assert.equal(renderHandoffWorkspace({}), "");
    const text = renderHandoffWorkspace({
      branch: "feature/import",
      worktreePath: "/work/tree",
      status: {
        files: Array.from({ length: 11 }, (_, index) => `src/file${index}.ts`),
        insertions: 40,
        deletions: 3,
      },
      changedFiles: ["src/a.ts", "src/b.ts"],
      pendingWork: [{ kind: "subagent", label: "Review the importer" }],
    });
    assert.deepEqual(text.split("\n"), [
      "[Workspace at handoff]",
      "- Branch: feature/import",
      "- Worktree: /work/tree",
      "- git status: 11 changed (+40 -3): src/file0.ts, src/file1.ts, src/file2.ts, src/file3.ts, src/file4.ts, src/file5.ts, src/file6.ts, src/file7.ts, and 3 more",
      "- Files changed during this chat (2): src/a.ts, src/b.ts",
      '- Background work still running at the switch: subagent "Review the importer"',
    ]);
    assert.include(
      renderHandoffWorkspace({ status: { files: [], insertions: 0, deletions: 0 } }),
      "git status: clean",
    );
  });
});
