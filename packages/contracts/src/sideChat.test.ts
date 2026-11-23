import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  parseSideChatCommand,
  SideChatId,
  SideChatRefInput,
  SideChatState,
  SideChatStreamValue,
  SideChatSubscribeInput,
  sideChatKindForDriver,
} from "./sideChat.ts";
import { ThreadId } from "./baseSchemas.ts";

const oldInput = Schema.Union([SideChatRefInput, Schema.Struct({ threadId: ThreadId })]);
const decodeOldInput = Schema.decodeUnknownSync(oldInput);
const decodeInput = Schema.decodeUnknownSync(SideChatSubscribeInput);
const decodeStreamValue = Schema.decodeUnknownSync(SideChatStreamValue);
const encodeStreamValue = Schema.encodeSync(SideChatStreamValue);

it("keeps old side-chat subscriptions and snapshots compatible with append negotiation", () => {
  const threadId = ThreadId.make("thread");
  const sideChatId = SideChatId.make("side");
  expect(decodeOldInput({ threadId, acceptTextPatches: true })).toEqual({
    threadId,
  });
  expect(decodeInput({ sideChatId })).toEqual({ sideChatId });
  const snapshot: SideChatState = {
    sideChatId,
    threadId,
    kind: "btw",
    status: "running",
    messages: [],
    error: null,
  };
  const patch = {
    kind: "text-append" as const,
    sideChatId,
    messageId: "answer",
    previousLength: 0,
    text: "text",
  };
  expect(decodeStreamValue(encodeStreamValue(snapshot))).toEqual(snapshot);
  expect(decodeStreamValue(encodeStreamValue(patch))).toEqual(patch);
});

it("gives each harness its own side-chat command, including Antigravity's /btw", () => {
  expect(
    ["antigravity", "claudeAgent", "grok", "opencode", "codex", "cursor", null].map(
      sideChatKindForDriver,
    ),
  ).toEqual(["btw", "btw", "btw", "btw", "side", null, null]);
  const kind = sideChatKindForDriver("antigravity");
  expect(parseSideChatCommand("/btw  which file did you change? ", kind)).toEqual({
    kind: "btw",
    prompt: "which file did you change?",
  });
  expect(parseSideChatCommand("/side which file?", kind)).toBeNull();
  expect(parseSideChatCommand("/goal finish the migration", kind)).toBeNull();
});
