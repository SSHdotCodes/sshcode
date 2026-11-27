import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_AGENT_BEHAVIOR, ThreadId, type AgentBehaviorLevels } from "@t3tools/contracts";
import { registerAgentBehavior } from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ChatControls from "./chatControls.ts";
import { make } from "./chatControls.ts";

const THREAD = ThreadId.make("thread-chat-controls");

describe("chat controls store", () => {
  it("records only newer activity, then a backfill can add older days", () => {
    const chatControls = make().store;
    chatControls.observeActivity(THREAD, ["2026-11-06T15:00:00.000Z", "2026-11-04T15:00:00.000Z"]);
    expect(chatControls.view(THREAD)).toMatchObject({
      dayCount: 1,
      lastActiveAt: "2026-11-06T15:00:00.000Z",
      subagentsEnabled: true,
      override: null,
    });
    const changed = chatControls.mergeActivity([
      { threadId: THREAD, at: "2026-11-04T15:00:00.000Z" },
      { threadId: THREAD, at: "2026-11-05T15:00:00.000Z" },
      { threadId: THREAD, at: "2026-11-06T15:00:00.000Z" },
    ]);
    expect(changed).toEqual([THREAD]);
    expect(chatControls.view(THREAD).dayCount).toBe(3);
    expect(
      chatControls.mergeActivity([{ threadId: THREAD, at: "2026-11-05T16:00:00.000Z" }]),
    ).toEqual([]);
  });

  it.effect("keeps a manual include or exclude and consumes the subagents notice once", () =>
    Effect.gen(function* () {
      const chatControls = make().store;
      yield* chatControls.command({
        action: "long-running",
        threadId: THREAD,
        placement: "include",
      });
      expect(chatControls.view(THREAD).override).toBe("include");
      yield* chatControls.command({
        action: "long-running",
        threadId: THREAD,
        placement: "exclude",
      });
      expect(chatControls.view(THREAD).override).toBe("exclude");
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: false });
      expect(chatControls.subagentsEnabled(THREAD)).toBe(false);
      expect(chatControls.consumeSubagentNotice(THREAD, false)).toBe(false);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: false });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      // On then off before any turn: the agent still has the off rules, so no notice.
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: false });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(true);
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      expect(chatControls.subagentsEnabled(THREAD)).toBe(true);
    }),
  );
  it.live("restores automatic membership on Undo and persists exclusions across restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-placement-" });
      const automatic = ThreadId.make("automatic");
      const open = (scope: Scope.Scope) =>
        Layer.build(
          ChatControls.layer.pipe(
            Layer.provide(
              Layer.succeed(ServerConfig.ServerConfig, {
                stateDir,
              } as ServerConfig.ServerConfig["Service"]),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.map((context) => Context.get(context, ChatControls.ChatControls)),
        );
      const firstScope = yield* Scope.make();
      const first = yield* open(firstScope);
      yield* first.command({ action: "long-running", threadId: THREAD, placement: "exclude" });
      yield* first.command({ action: "long-running", threadId: automatic, placement: "include" });
      yield* first.command({ action: "long-running", threadId: automatic, placement: null });
      yield* Scope.close(firstScope, Exit.void);
      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const second = yield* open(secondScope);
      expect(second.view(THREAD).override).toBe("exclude");
      expect(second.view(automatic).override).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("announces re-enabled subagents once, only after an off-to-on transition", () =>
    Effect.gen(function* () {
      const chatControls = make().store;
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: false });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(true);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      expect(chatControls.subagentsEnabled(THREAD)).toBe(true);
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(true);
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
    }),
  );

  it.effect(
    "Settings > Agents None turns subagents off in every chat, like each chat's switch",
    () =>
      Effect.gen(function* () {
        let levels: AgentBehaviorLevels = DEFAULT_AGENT_BEHAVIOR;
        registerAgentBehavior(() => levels);
        const chatControls = make().store;
        const ownSwitchOff = ThreadId.make("thread-own-switch-off");
        yield* chatControls.command({
          action: "subagents",
          threadId: ownSwitchOff,
          enabled: false,
        });
        chatControls.consumeSubagentNotice(ownSwitchOff, true);
        expect(chatControls.subagentsEnabled(THREAD)).toBe(true);
        expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);

        levels = { ...DEFAULT_AGENT_BEHAVIOR, subagents: "none" };
        expect(chatControls.subagentsEnabled(THREAD)).toBe(false);
        // The chat keeps its own choice for when the level changes back.
        expect(chatControls.view(THREAD).subagentsEnabled).toBe(true);
        // A live session hears it once; a chat whose own switch was already off hears nothing.
        expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(true);
        expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
        expect(chatControls.consumeSubagentNotice(ownSwitchOff, true)).toBe(false);
        // A chat's own switch cannot turn subagents back on under None, and flipping it while
        // effective state stays off must not emit a duplicate notice.
        yield* chatControls.command({ action: "subagents", threadId: ownSwitchOff, enabled: true });
        expect(chatControls.subagentsEnabled(ownSwitchOff)).toBe(false);
        expect(chatControls.consumeSubagentNotice(ownSwitchOff, true)).toBe(false);

        // Turning a chat's own switch off under None then returning Settings to Default keeps
        // effective state off throughout, so neither transition emits a bogus notice.
        const turnedOffUnderNone = ThreadId.make("thread-turned-off-under-none");
        expect(chatControls.consumeSubagentNotice(turnedOffUnderNone, true)).toBe(true);
        yield* chatControls.command({
          action: "subagents",
          threadId: turnedOffUnderNone,
          enabled: false,
        });
        expect(chatControls.consumeSubagentNotice(turnedOffUnderNone, true)).toBe(false);

        levels = { ...DEFAULT_AGENT_BEHAVIOR, subagents: "low" };
        expect(chatControls.subagentsEnabled(THREAD)).toBe(true);
        expect(chatControls.subagentsEnabled(ownSwitchOff)).toBe(true);
        expect(chatControls.subagentsEnabled(turnedOffUnderNone)).toBe(false);
        expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(true);
        expect(chatControls.consumeSubagentNotice(ownSwitchOff, true)).toBe(true);
        expect(chatControls.consumeSubagentNotice(turnedOffUnderNone, true)).toBe(false);
        // None and back before the next message: the session still has the rules in force.
        levels = { ...DEFAULT_AGENT_BEHAVIOR, subagents: "none" };
        expect(chatControls.subagentsEnabled(THREAD)).toBe(false);
        levels = DEFAULT_AGENT_BEHAVIOR;
        expect(chatControls.subagentsEnabled(THREAD)).toBe(true);
        expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.sync(() => registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR))),
      ),
  );

  it.effect("asks once on the first subagent and hides the ask while the switch is off", () =>
    Effect.gen(function* () {
      const chatControls = make().store;
      const other = ThreadId.make("thread-other");
      expect(chatControls.firstSubagentChecked(THREAD)).toBe(false);
      chatControls.setFirstSubagentAsk(THREAD, "task-1");
      expect(chatControls.firstSubagentChecked(THREAD)).toBe(true);
      expect(chatControls.view(THREAD).firstSubagentAsk).toBe("task-1");
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: false });
      expect(chatControls.view(THREAD).firstSubagentAsk).toBeNull();
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      expect(chatControls.view(THREAD).firstSubagentAsk).toBe("task-1");

      expect(chatControls.answerFirstSubagent(THREAD, "solo")).toBe(true);
      expect(chatControls.view(THREAD)).toMatchObject({
        subagentsEnabled: false,
        firstSubagentAsk: null,
      });
      expect(chatControls.consumeSubagentNotice(THREAD, true)).toBe(true);
      expect(chatControls.answerFirstSubagent(THREAD, "fine")).toBe(false);
      yield* chatControls.command({ action: "subagents", threadId: THREAD, enabled: true });
      chatControls.setFirstSubagentAsk(THREAD, "task-1");
      expect(chatControls.view(THREAD).firstSubagentAsk).toBeNull();

      chatControls.setFirstSubagentAsk(other, "task-2");
      expect(chatControls.answerFirstSubagent(other, "fine")).toBe(true);
      expect(chatControls.view(other)).toMatchObject({
        subagentsEnabled: true,
        firstSubagentAsk: null,
      });
      chatControls.setFirstSubagentAsk(ThreadId.make("thread-ended"), null);
      expect(chatControls.firstSubagentChecked(ThreadId.make("thread-ended"))).toBe(true);
    }),
  );

  it("keeps an unanswered ask as Fine once its minute is over", () => {
    const due: Array<() => void> = [];
    const chatControls = make({ afterAskDelay: (keepFine) => due.push(keepFine) }).store;
    const solo = ThreadId.make("thread-solo-in-time");
    chatControls.setFirstSubagentAsk(THREAD, "task-1");
    chatControls.setFirstSubagentAsk(solo, "task-2");
    expect(chatControls.view(THREAD).firstSubagentAsk).toBe("task-1");
    // Answered in time: the timer finds nothing to do and the switch stays off.
    expect(chatControls.answerFirstSubagent(solo, "solo")).toBe(true);
    for (const keepFine of due) keepFine();
    expect(chatControls.view(THREAD)).toMatchObject({
      subagentsEnabled: true,
      firstSubagentAsk: null,
    });
    expect(chatControls.firstSubagentAnswered(THREAD)).toBe(true);
    expect(chatControls.view(solo).subagentsEnabled).toBe(false);
    // It never asks again in this chat.
    chatControls.setFirstSubagentAsk(THREAD, "task-3");
    expect(chatControls.view(THREAD).firstSubagentAsk).toBeNull();
  });

  it.live("saves an open ask and an answer across restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-first-subagent-ask-" });
      const answered = ThreadId.make("thread-answered");
      const open = (scope: Scope.Scope) =>
        Layer.build(
          ChatControls.layer.pipe(
            Layer.provide(
              Layer.succeed(ServerConfig.ServerConfig, {
                stateDir,
              } as ServerConfig.ServerConfig["Service"]),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.map((context) => Context.get(context, ChatControls.ChatControls)),
        );
      const firstScope = yield* Scope.make();
      const first = yield* open(firstScope);
      first.setFirstSubagentAsk(THREAD, "task-open");
      first.setFirstSubagentAsk(answered, "task-answered");
      first.answerFirstSubagent(answered, "fine");
      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const second = yield* open(secondScope);
      // An ask left open by the restart is kept as "Fine"; an answer is stored.
      expect(second.view(THREAD).firstSubagentAsk).toBeNull();
      expect(second.firstSubagentChecked(THREAD)).toBe(true);
      expect(second.firstSubagentChecked(answered)).toBe(true);
      second.setFirstSubagentAsk(answered, "task-answered");
      expect(second.view(answered).firstSubagentAsk).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
