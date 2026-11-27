import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
} from "./AcpAdapterV2.testkit.ts";
import { makeAntigravitySideChat } from "./AntigravitySideChat.ts";

const driver = ProviderDriverKind.make("antigravity");
const threadId = ThreadId.make("btw-live");
const fixture = (name: string) =>
  readProviderReplayTranscript(
    new URL(`../testkit/fixtures/antigravity_side_question/${name}`, import.meta.url),
  );

const message = (
  index: number,
  role: "user" | "assistant",
  kind: string,
  text: string,
  status = "completed",
): OrchestrationV2HistoricalMessage => ({
  role,
  text,
  threadId,
  runId: RunId.make(index < 2 ? "run-1" : "run-2"),
  itemId: TurnItemId.make(`item-${index}`),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  status,
  kind,
});
/** The thread as SSHCode projected it while the recorded main turn ran `sleep 45`. */
const transcript = [
  message(
    0,
    "user",
    "user_message",
    "Remember this codeword for later: KESTREL-19. Reply with just OK.",
  ),
  message(1, "assistant", "assistant_message", "OK"),
  message(
    2,
    "user",
    "user_message",
    "Run exactly this shell command and wait for it: `sleep 45 && echo finished-main`. Then reply with its output and nothing else.",
  ),
  message(
    3,
    "assistant",
    "command_execution",
    "Command: sleep 45 && echo finished-main\nExit code: unknown\n",
    "inProgress",
  ),
];

const sessionIdOf = (recorded: ProviderReplayTranscript) => {
  for (const entry of recorded.entries) {
    if (entry.type !== "emit_inbound") continue;
    const frame = entry.frame as { method?: string; result?: { sessionId?: string } };
    if (frame.method === "session/new" && frame.result?.sessionId) return frame.result.sessionId;
  }
  throw new Error("transcript has no session/new reply");
};

/** One replayed `agy acp` process per transcript, in the order the side chat spawns them. */
const makeHarness = Effect.fnUntraced(function* (
  transcripts: ReadonlyArray<ProviderReplayTranscript>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "antigravity-btw-test-" });
  const cliDataDirectory = path.join(root, "antigravity-cli");
  const scriptPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
  );
  // Each recorded session leaves files where the agy CLI keeps them, beside another session's.
  const files = (sessionId: string) => [
    path.join(cliDataDirectory, "conversations", `${sessionId}.db`),
    path.join(cliDataDirectory, "annotations", `${sessionId}.pbtxt`),
    path.join(cliDataDirectory, "brain", sessionId, "scratch", "notes.md"),
  ];
  const otherSession = "0317d99b-0cd8-48b1-9ef2-867ffcf63737";
  for (const sessionId of [...transcripts.map(sessionIdOf), otherSession]) {
    for (const file of files(sessionId)) {
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
      yield* fileSystem.writeFileString(file, "");
    }
  }
  const cwds: Array<string> = [];
  const statusPaths: Array<string> = [];
  const openSideChat = yield* makeAntigravitySideChat({
    withProcess: (_stop, task) => task,
    defaultModel: Effect.succeed(undefined),
    profileDirectory: path.join(root, "profile"),
    cliDataDirectory,
    makeRuntime: (input) =>
      Effect.gen(function* () {
        const recorded = transcripts[cwds.length];
        if (recorded === undefined) return yield* Effect.die("no transcript for this process");
        const statusPath = path.join(root, `status-${cwds.length}.json`);
        cwds.push(input.cwd);
        statusPaths.push(statusPath);
        yield* fileSystem
          .writeFileString(`${statusPath}.transcript.json`, JSON.stringify(recorded))
          .pipe(Effect.orDie);
        return yield* makeAntigravityAcpRuntime({
          ...input,
          runtimeVersion: "1.5.13",
          childProcessSpawner: spawner,
          spawn: {
            command: process.execPath,
            args: ["--experimental-strip-types", scriptPath],
            cwd: input.cwd,
            env: {
              ...process.env,
              T3_ACP_REPLAY_TRANSCRIPT_PATH: `${statusPath}.transcript.json`,
              T3_ACP_REPLAY_STATUS_PATH: statusPath,
              T3_ACP_REPLAY_WORKSPACE: input.cwd,
            },
          },
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      }),
  });
  const chat = yield* openSideChat({
    threadId,
    providerThread: {
      id: ProviderThreadId.make("provider-thread"),
      providerInstanceId: ProviderInstanceId.make("antigravity"),
      providerSessionId: null,
      nativeThreadRef: { nativeId: "b01cc089-7967-471c-a365-48ddc126be48" },
    } as unknown as OrchestrationV2ProviderThread,
    modelSelection: {
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-3.8-flash",
    },
    runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
    }),
    transcript: Effect.succeed(transcript),
  });
  const ask = (prompt: string) =>
    Effect.gen(function* () {
      const updates: Array<ProviderAdapter.ProviderAdapterV2SideChatUpdate> = [];
      const exit = yield* chat
        .ask({ prompt, onUpdate: (update) => Effect.sync(() => void updates.push(update)) })
        .pipe(Effect.exit);
      return { exit, updates };
    });
  const replayed = Effect.forEach(transcripts, (recorded, index) =>
    decodeAcpReplayTranscript(recorded, driver).pipe(
      Effect.flatMap((decoded) =>
        makeAcpReplayCompletenessAssertion(fileSystem, statusPaths[index]!, decoded),
      ),
    ),
  );
  const exists = (file: string) => fileSystem.exists(file);
  const leftovers = Effect.gen(function* () {
    const left: Array<string> = [];
    for (const recorded of transcripts) {
      for (const file of files(sessionIdOf(recorded))) {
        if (yield* exists(file)) left.push(path.relative(cliDataDirectory, file));
      }
    }
    for (const cwd of cwds) if (yield* exists(cwd)) left.push(cwd);
    return left;
  });
  const otherSessionKept = Effect.forEach(files(otherSession), exists).pipe(
    Effect.map((present) => present.every(Boolean)),
  );
  return { ask, replayed, leftovers, otherSessionKept, processes: () => cwds.length };
});

const testLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const prefixUntilPrompt = (recorded: ProviderReplayTranscript) =>
  recorded.entries.slice(
    0,
    recorded.entries.findIndex(
      (entry) => entry.type === "expect_outbound" && entry.label === "request:session/prompt",
    ),
  );
const update = (sessionId: string, value: Record<string, unknown>): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId, update: value },
  },
});

describe("Antigravity side questions", () => {
  it.effect(
    "answers from the thread's transcript in a side agy session, streams, and leaves no session behind",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture("antigravity_transcript.ndjson");
        const followUp = yield* fixture("antigravity_follow_up_transcript.ndjson");
        const harness = yield* makeHarness([first, followUp]);

        const codeword = yield* harness.ask("What codeword did I give you?");
        assert.deepEqual(
          codeword.exit,
          Exit.succeed("The codeword you gave me is **KESTREL-19**."),
        );
        // The follow-up's recorded prompt carries the first exchange, so the side thread continues.
        const running = yield* harness.ask(
          "Which command is running right now, and has it finished yet?",
        );
        assert.deepEqual(
          running.exit,
          Exit.succeed(
            "The command running right now is `sleep 45 && echo finished-main`. No, it has not finished yet (it is still in progress).",
          ),
        );
        assert.deepEqual(
          running.updates.map((update) => (update.type === "text" ? update.text : update.type)),
          [
            "The command running right now is `sleep ",
            "The command running right now is `sleep 45 && echo finished-main`. No, it has not finished yet (it is still in progress).",
          ],
        );

        // Every recorded frame was sent as recorded, prompt text included, and nothing else.
        yield* harness.replayed;
        assert.equal(harness.processes(), 2);
        assert.deepEqual(yield* harness.leftovers, []);
        assert.isTrue(yield* harness.otherSessionKept);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    30_000,
  );

  it.effect("denies the tools a side question asks for and shows what it tried", () =>
    Effect.gen(function* () {
      const first = yield* fixture("antigravity_transcript.ndjson");
      const sessionId = sessionIdOf(first);
      const harness = yield* makeHarness([
        {
          ...first,
          scenario: "antigravity_side_question_denied_tool",
          entries: [
            ...prefixUntilPrompt(first),
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            update(sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: "edit-1",
              title: "Edit README.md",
              kind: "edit",
              status: "pending",
            }),
            {
              type: "emit_inbound",
              frame: {
                kind: "request",
                method: "session/request_permission",
                params: {
                  sessionId,
                  toolCall: { toolCallId: "edit-1", title: "Edit README.md" },
                  options: [
                    { optionId: "allow", name: "Allow", kind: "allow_once" },
                    { optionId: "deny", name: "Deny", kind: "reject_once" },
                  ],
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                kind: "response",
                method: "session/request_permission",
                result: { outcome: { outcome: "selected", optionId: "deny" } },
              },
            },
            update(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: "edit-1",
              status: "failed",
            }),
            update(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "A side question cannot edit files." },
            }),
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "end_turn" },
              },
            },
          ],
        },
      ]);
      const result = yield* harness.ask("Fix the typo in README.md");
      assert.deepEqual(result.exit, Exit.succeed("A side question cannot edit files."));
      assert.deepEqual(
        result.updates
          .filter((update) => update.type === "activity")
          .map((update) => update.activity),
        [
          { id: "edit-1", label: "Edit README.md", status: "running" },
          { id: "edit-1", label: "Edit README.md", status: "failed" },
        ],
      );
      yield* harness.replayed;
      assert.deepEqual(yield* harness.leftovers, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails with agy's own words when the model is out of quota", () =>
    Effect.gen(function* () {
      const first = yield* fixture("antigravity_transcript.ndjson");
      const quota =
        "You have exhausted your capacity on this model. Your quota will reset after 2h31m.";
      const harness = yield* makeHarness([
        {
          ...first,
          scenario: "antigravity_side_question_quota",
          entries: [
            ...prefixUntilPrompt(first),
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                error: { code: -32603, message: quota },
              },
            },
          ],
        },
      ]);
      const result = yield* harness.ask("What codeword did I give you?");
      assert.isTrue(Exit.isFailure(result.exit));
      const failure = Exit.isFailure(result.exit) ? result.exit.cause : undefined;
      assert.include(String(failure), quota);
      yield* harness.replayed;
      assert.deepEqual(yield* harness.leftovers, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    {
      stopReason: "end_turn",
      text: "Usage Limit Reached\n\nYou have reached your current quota for this period.",
      failure: "Usage Limit Reached",
    },
    { stopReason: "refusal", text: "I can't finish that.", failure: "refused this request" },
    { stopReason: "max_tokens", text: "An unfinished reply", failure: "output token limit" },
  ])("fails when a side question ends with $stopReason and text", ({ stopReason, text, failure }) =>
    Effect.gen(function* () {
      const first = yield* fixture("antigravity_transcript.ndjson");
      const harness = yield* makeHarness([
        {
          ...first,
          scenario: "antigravity_side_question_unsuccessful_stop",
          entries: [
            ...prefixUntilPrompt(first),
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            update(sessionIdOf(first), {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            }),
            {
              type: "emit_inbound",
              frame: { kind: "response", method: "session/prompt", result: { stopReason } },
            },
          ],
        },
      ]);
      const result = yield* harness.ask("What codeword did I give you?");
      assert.isTrue(Exit.isFailure(result.exit));
      if (Exit.isFailure(result.exit)) assert.include(String(result.exit.cause), failure);
      yield* harness.replayed;
      assert.deepEqual(yield* harness.leftovers, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
