import { SubagentsEnabled } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as BoxFaces from "./boxFaces.ts";
import * as ChatControls from "./chatControls.ts";
import * as ChatTabs from "./chatTabs.ts";

it.live("isolates records, subscribers and shutdown writers across two state directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-session-box-isolation-" });
    const threadId = ThreadId.make("same-thread");
    const build = (stateDir: string, scope: Scope.Scope) =>
      Layer.build(
        Layer.mergeAll(ChatTabs.layer, ChatControls.layer, BoxFaces.layer).pipe(
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir,
            } as ServerConfig.ServerConfig["Service"]),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.map((context) => ({
          tabs: Context.get(context, ChatTabs.ChatTabs),
          controls: Context.get(context, ChatControls.ChatControls),
          faces: Context.get(context, BoxFaces.BoxFaces),
          subagentsEnabled: Context.get(context, SubagentsEnabled),
        })),
      );
    yield* fs.makeDirectory(`${root}/one`);
    yield* fs.makeDirectory(`${root}/two`);
    const firstScope = yield* Scope.make();
    const secondScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
    yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
    const first = yield* build(`${root}/one`, firstScope);
    first.tabs.fileByModel({ threadId, tab: "First", title: "First title", now: 1 });
    first.tabs.markExistingSorted();
    const comparison = {
      id: "first-comparison",
      title: "Compare",
      threadIds: [threadId, ThreadId.make("other-thread")],
    };
    yield* first.tabs.command({ action: "compare", comparison }, { titleOf: () => null, now: 1 });
    first.faces.set(threadId, "topic-mobile");
    yield* first.controls.command({ action: "subagents", threadId, enabled: false });
    first.controls.markActivityIndexed();
    first.controls.observeActivity(threadId, ["2026-11-06T15:00:00.000Z"]);

    const second = yield* build(`${root}/two`, secondScope);
    expect(second.tabs.list()).toEqual([]);
    expect(second.tabs.isFiled(threadId)).toBe(false);
    expect(second.tabs.existingSorted()).toBe(false);
    expect(second.tabs.comparison(threadId)).toBeNull();
    expect(second.faces.get(threadId)).toBeNull();
    expect(second.controls.view(threadId)).toEqual({
      override: null,
      dayCount: 0,
      lastActiveAt: null,
      subagentsEnabled: true,
      firstSubagentAsk: null,
    });
    expect(second.controls.needsActivityIndex()).toBe(true);
    expect(first.subagentsEnabled(threadId)).toBe(false);
    expect(second.subagentsEnabled(threadId)).toBe(true);
    let firstCatalogChanges = 0;
    let firstSubagentChanges = 0;
    const unsubscribeTabs = first.tabs.subscribe(() => firstCatalogChanges++);
    const unsubscribeControls = first.controls.subscribeSubagentsChanged(
      () => firstSubagentChanges++,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeTabs();
        unsubscribeControls();
      }),
    );
    second.tabs.fileByModel({ threadId, tab: "Second", title: "Second title", now: 2 });
    second.faces.set(threadId, "topic-cleanup");
    yield* second.controls.command({ action: "subagents", threadId, enabled: false });
    yield* second.controls.command({ action: "long-running", threadId, placement: "include" });
    expect(firstCatalogChanges).toBe(0);
    expect(firstSubagentChanges).toBe(0);
    expect(first.tabs.get(threadId)?.name).toBe("First");
    expect(first.faces.get(threadId)).toBe("topic-mobile");
    expect(first.controls.view(threadId).override).toBeNull();

    // Closing the first instance must flush its own data and leave the second writer active.
    yield* Scope.close(firstScope, Exit.void);
    yield* second.tabs.command(
      { action: "rename", tab: "Second", to: "Still active" },
      { titleOf: () => null, now: 3 },
    );
    second.faces.set(threadId, "topic-app");
    yield* second.controls.command({ action: "subagents", threadId, enabled: true });
    expect(first.subagentsEnabled(threadId)).toBe(false);
    expect(second.subagentsEnabled(threadId)).toBe(true);
    yield* Scope.close(secondScope, Exit.void);

    const reloadedFirst = yield* build(`${root}/one`, yield* Effect.scope);
    const reloadedSecond = yield* build(`${root}/two`, yield* Effect.scope);
    expect(reloadedFirst.tabs.get(threadId)?.name).toBe("First");
    expect(reloadedSecond.tabs.get(threadId)?.name).toBe("Still active");
    expect(reloadedFirst.tabs.existingSorted()).toBe(true);
    expect(reloadedFirst.tabs.comparison(threadId)).toEqual(comparison);
    expect(reloadedSecond.tabs.comparison(threadId)).toBeNull();
    expect(reloadedSecond.tabs.existingSorted()).toBe(false);
    expect(reloadedFirst.faces.get(threadId)).toBe("topic-mobile");
    expect(reloadedSecond.faces.get(threadId)).toBe("topic-app");
    expect(reloadedFirst.controls.view(threadId)).toMatchObject({
      dayCount: 1,
      override: null,
      subagentsEnabled: false,
    });
    expect(reloadedSecond.controls.view(threadId)).toMatchObject({
      dayCount: 0,
      override: "include",
      subagentsEnabled: true,
    });
    expect(reloadedFirst.controls.needsActivityIndex()).toBe(false);
    expect(reloadedSecond.controls.needsActivityIndex()).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
