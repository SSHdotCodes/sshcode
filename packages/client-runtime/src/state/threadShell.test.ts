import {
  EnvironmentId,
  NodeId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "./orchestrationV2TestFixtures.ts";
import { createBotThreadIdsAtom } from "./bots.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { isThreadWorking } from "./threadInbox.ts";
import {
  childThreadInputsTitle,
  createEnvironmentThreadShellAtoms,
  threadDetailToShell,
} from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");
const otherProjectId = ProjectId.make("other-project");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    threads: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
  };
}

describe("v2 thread shell lists", () => {
  it("skips child lineage indexing until a subagent needs input", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    let parentIdReads = 0;
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("idle-child"),
      lineage: {
        ...v2ThreadShell.lineage,
        relationshipToParent: "subagent" as const,
        get parentThreadId() {
          parentIdReads++;
          return v2ThreadShell.id;
        },
      },
    };
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: v2ThreadShell.id });
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, child],
    });
    expect(registry.get(inputs)).toEqual([]);
    expect(parentIdReads).toBe(0);
    registry.dispose();
  });

  it("preserves ordered reference arrays when a middle thread changes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.threadRefsAtom);
    const before = registry.get(threads.threadRefsAtom);
    registry.set(
      snapshotAtom(environmentId),
      applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...snapshot.threads[1]!, title: "Updated" },
      }),
    );
    expect(registry.get(threads.threadRefsAtom)).toBe(before);
    dispose();
    registry.dispose();
  });

  it("leaves Overview conversations out of every thread list", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: ["a", "overview-1"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    });
    const dispose = registry.mount(threads.threadRefsAtom);
    expect(registry.get(threads.threadRefsAtom).map((ref) => ref.threadId)).toEqual(["a"]);
    dispose();
    registry.dispose();
  });

  it("keeps the helper-filtered list and lookup index on a cursor-only shell event", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    let reads = 0;
    const helper = {
      ...v2ThreadShell,
      get id() {
        reads++;
        return ThreadId.make("models:helper");
      },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, helper] };
    const source = snapshotAtom(environmentId);
    registry.set(source, snapshot);
    const index = threads.environmentThreadIndexAtom(environmentId);
    const list = threads.environmentThreadsAtom(environmentId);
    registry.mount(index);
    registry.mount(list);
    const before = registry.get(index);
    const visible = registry.get(list);
    expect(visible).toEqual([v2ThreadShell]);
    reads = 0;
    registry.set(source, { ...snapshot, snapshotSequence: snapshot.snapshotSequence + 1 });
    expect(registry.get(index)).toBe(before);
    expect(registry.get(list)).toBe(visible);
    expect(reads).toBe(0);
    registry.set(source, { ...snapshot, threads: [helper] });
    expect(registry.get(list)).toEqual([]);
    expect(registry.get(index).has(v2ThreadShell.id)).toBe(false);
    registry.dispose();
  });

  it("keeps Models helpers out of all web/mobile lists while retaining direct access", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const helper = {
      ...v2ThreadShell,
      id: ThreadId.make("models:existing-saved-id"),
      title: "Models",
      status: "waiting" as const,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("model-question"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, helper],
    });
    const dispose = registry.mount(threads.threadShellsAtom);
    const ref = { environmentId, threadId: helper.id };
    expect(registry.get(threads.threadRefsAtom).map((ref) => ref.threadId)).toEqual([
      v2ThreadShell.id,
    ]);
    expect(
      registry.get(threads.environmentThreadRefsAtom(environmentId)).map((ref) => ref.threadId),
    ).toEqual([v2ThreadShell.id]);
    expect(registry.get(threads.threadShellsAtom).map((thread) => thread.id)).toEqual([
      v2ThreadShell.id,
    ]);
    expect(registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      v2ThreadShell.id,
    ]);
    expect(
      registry
        .get(
          threads.threadShellsForProjectRefsAtom([{ environmentId, projectId: helper.projectId }]),
        )
        .map((thread) => thread.id),
    ).toEqual([v2ThreadShell.id]);
    expect(registry.get(threads.threadShellAtom(ref))?.id).toBe(helper.id);
    expect(registry.get(threads.modelManagerThreadRefAtom(environmentId))).toEqual(ref);
    // Finished and waiting on nothing: the picker shows no old Models conversation.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, { ...helper, status: "completed", pendingRuntimeRequest: null }],
    });
    expect(registry.get(threads.modelManagerThreadRefAtom(environmentId))).toBeNull();
    dispose();
    registry.dispose();
  });

  it("keeps bot home chats out of every list while retaining direct access", () => {
    const { registry, snapshotAtom, catalogValueAtom } = makeHarness();
    const botChat = { ...v2ThreadShell, id: ThreadId.make("bot-home"), title: "Pip" };
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, botChat],
    });
    const settingsAtom = Atom.make<{ bots?: { enabled: boolean; list: Array<never> } } | null>(
      null,
    );
    const bot = {
      id: "bot-1",
      name: "Pip",
      color: "blue",
      target: { instanceId: "codex", model: "gpt-5" },
      permissions: {
        manageChats: true,
        answerQuestions: false,
        startSubagents: true,
        messageFirst: true,
      },
      threadId: botChat.id,
      createdAt: v2Now,
    } as never;
    const threads = createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom,
      hiddenThreadIdsAtom: createBotThreadIdsAtom(() => settingsAtom),
    });
    const dispose = registry.mount(threads.threadShellsAtom);
    const listed = () => ({
      refs: registry.get(threads.threadRefsAtom).map((ref) => ref.threadId),
      shells: registry.get(threads.threadShellsAtom).map((thread) => thread.id),
      navigation: registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id),
      project: registry
        .get(
          threads.threadShellsForProjectRefsAtom([{ environmentId, projectId: botChat.projectId }]),
        )
        .map((thread) => thread.id),
    });
    const both = [v2ThreadShell.id, botChat.id];
    const hiddenOnlyProjects = () => [
      ...registry.get(threads.hiddenOnlyProjectIdsAtom(environmentId)),
    ];
    // A chat no saved bot owns lists like any other chat.
    expect(listed()).toEqual({ refs: both, shells: both, navigation: both, project: both });
    // Off with the bot kept: its home chat stays hidden, waiting for Bots to come back on.
    registry.set(settingsAtom, { bots: { enabled: false, list: [bot] } });
    const only = [v2ThreadShell.id];
    expect(listed()).toEqual({ refs: only, shells: only, navigation: only, project: only });

    registry.set(settingsAtom, { bots: { enabled: true, list: [bot] } });
    expect(listed()).toEqual({ refs: only, shells: only, navigation: only, project: only });
    // Its project still holds a listed chat, so it stays in project lists.
    expect(hiddenOnlyProjects()).toEqual([]);
    expect(
      registry.get(threads.threadShellAtom({ environmentId, threadId: botChat.id }))?.title,
    ).toBe("Pip");
    // Running-work bookkeeping still sees it.
    expect(
      registry.get(threads.environmentThreadsAtom(environmentId)).map((thread) => thread.id),
    ).toEqual(both);

    // A project made only for bot chats (the bot's "No project") leaves project lists.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, { ...botChat, projectId: ProjectId.make("bot-scratch") }],
    });
    expect(hiddenOnlyProjects()).toEqual(["bot-scratch"]);
    // Off keeps it hidden too; only removing the bot (which deletes its chat) frees it.
    registry.set(settingsAtom, { bots: { enabled: false, list: [bot] } });
    expect(hiddenOnlyProjects()).toEqual(["bot-scratch"]);
    registry.set(settingsAtom, { bots: { enabled: false, list: [] } });
    expect(hiddenOnlyProjects()).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("keeps navigation stable on hidden subagent updates and retains user forks", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const fork = {
      ...child,
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" as const },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, child, fork] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const before = registry.get(threads.navigationThreadShellsAtom);
    expect(before.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, { ...child, title: "Child streaming" }, fork],
    });
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(before);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    dispose();
    registry.dispose();
  });

  it("keeps forks and legacy archived rows in the top-level list without presenting children", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    let titleReads = 0;
    const root = { ...v2ThreadShell, archivedAt: v2Now };
    const fork = {
      ...v2ThreadShell,
      id: ThreadId.make("fork"),
      lineage: {
        rootThreadId: root.id,
        parentThreadId: root.id,
        relationshipToParent: "fork" as const,
      },
    };
    const child = {
      ...fork,
      id: ThreadId.make("child"),
      lineage: {
        ...fork.lineage,
        relationshipToParent: "subagent" as const,
      },
      get title() {
        titleReads++;
        return "Child";
      },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, fork, child] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const release = registry.mount(threads.topLevelThreadShellsAtom);
    const before = registry.get(threads.topLevelThreadShellsAtom);
    expect(before.map((t) => t.id)).toEqual([root.id, fork.id]);
    expect(titleReads).toBe(0);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [
        root,
        fork,
        {
          ...child,
          title: "Streaming",
        },
      ],
    });
    expect(registry.get(threads.topLevelThreadShellsAtom)).toBe(before);

    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [
        root,
        fork,
        {
          ...child,
          status: "waiting",
          pendingRuntimeRequest: {
            kind: "user_input",
            id: RuntimeRequestId.make("ask"),
            createdAt: v2Now,
          },
        },
      ],
    });
    expect(registry.get(threads.topLevelThreadShellsAtom)[0]?.pendingSubagentRequest).toBe(
      "user_input",
    );
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    release();
    registry.dispose();
  });

  it("hides remote children on web and mobile while preserving direct access", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("studio-child"),
      status: "running" as const,
      activityRunStatus: "running" as const,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("approval"),
        kind: "permission" as const,
        createdAt: v2Now,
      },
      lineage: {
        ...root.lineage,
        rootThreadId: ThreadId.make("studio-child"),
        // The same id may exist locally, but it is a parent in another environment.
        parentThreadId: root.id,
        parentEnvironmentId: remoteEnvironmentId,
        relationshipToParent: "subagent" as const,
      },
    };
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, child] });
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    expect(registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      root.id,
    ]);
    expect(registry.get(threads.threadShellAtom({ environmentId, threadId: child.id }))?.id).toBe(
      child.id,
    );
    expect(
      registry.get(threads.threadShellAtom({ environmentId, threadId: root.id }))
        ?.pendingSubagentRequest,
    ).toBeNull();
    expect(
      registry.get(threads.childThreadInputsAtom({ environmentId, threadId: root.id })),
    ).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("counts a subagent question on its parent only while the subagent runs", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, child] });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    // A follow-up queued behind the blocked run leaves the question live.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "queued" as const }],
    });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    // An async question stays pending after the run that asked it completes.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "completed" as const, activityRunStatus: null }],
    });
    expect(registry.get(inputs)).toEqual([]);
    // Older servers omit the activity run, so the latest run's status decides.
    const { activityRunStatus: _omitted, ...legacyChild } = child;
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...legacyChild, status: "completed" as const }],
    });
    expect(registry.get(inputs)).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("leaves a delegated task's question to the parent agent but still surfaces its approvals", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("delegated"),
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      forkedFrom: { type: "node" as const, nodeId: NodeId.make("node:delegated-task:quest") },
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(inputs);
    const disposeShells = registry.mount(threads.threadShellsAtom);
    const rootShell = () =>
      registry.get(threads.threadShellsAtom).find((thread) => thread.id === root.id);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, child] });
    expect(registry.get(inputs)).toEqual([]);
    expect(rootShell()?.pendingSubagentRequest).toBeNull();
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [
        root,
        {
          ...child,
          pendingRuntimeRequest: { ...child.pendingRuntimeRequest, kind: "command" as const },
        },
      ],
    });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    expect(rootShell()?.pendingSubagentRequest).toBe("approval");
    disposeShells();
    dispose();
    registry.dispose();
  });

  it("brings a parent back from Working while a nested subagent waits for approval", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("review"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const grandchild = {
      ...child,
      id: ThreadId.make("review-helper"),
      lineage: { ...child.lineage, parentThreadId: child.id },
    };
    // The parent's turn ended; the delegated review keeps it in Working.
    const root = {
      ...v2ThreadShell,
      latestRunId: RunId.make("root-run"),
      status: "completed" as const,
      pendingBackgroundTasks: [
        { taskId: "review", kind: "subagent" as const, childThreadId: child.id },
      ],
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    const parent = threads.threadShellAtom({ environmentId, threadId: root.id });
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const disposeParent = registry.mount(parent);
    const disposeInputs = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, { ...grandchild, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("approval");
    expect(isThreadWorking(registry.get(parent)!)).toBe(false);
    const asking = registry.get(inputs);
    expect(asking.map((thread) => thread.id)).toEqual([grandchild.id]);
    expect(childThreadInputsTitle(asking)).toBe("Subagent needs approval");

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBeNull();
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);
    disposeInputs();
    disposeParent();
    registry.dispose();
  });

  it("leaves switched-off environments out of navigation", () => {
    const { registry, threads, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const environmentsOf = () =>
      new Set(registry.get(threads.navigationThreadShellsAtom).map((t) => t.environmentId));
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));

    const setRemoteEnabled = (enabled: boolean) => {
      const catalog = registry.get(catalogValueAtom);
      const entries = new Map(catalog.entries);
      entries.set(remoteEnvironmentId, { ...entries.get(remoteEnvironmentId)!, enabled });
      registry.set(catalogValueAtom, { ...catalog, entries });
    };
    setRemoteEnabled(false);
    expect(environmentsOf()).toEqual(new Set([environmentId]));
    setRemoteEnabled(true);
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));
    dispose();
    registry.dispose();
  });

  it("shares point and list values without retaining an atom for every listed thread", () => {
    const harness = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: Array.from({ length: 200 }, (_, index) => ({
        ...v2ThreadShell,
        id: ThreadId.make(`thread-${index}`),
      })),
    };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const listAtom = harness.threads.threadShellsAtom;
    const projectListAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    const disposeProjectList = harness.registry.mount(projectListAtom);
    try {
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(200);
      expect(harness.registry.get(projectListAtom)).toEqual(before);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
      const firstAtom = harness.threads.threadShellAtom({
        environmentId,
        threadId: snapshot.threads[0]!.id,
      });
      expect(harness.registry.get(firstAtom)).toBe(before[0]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        snapshotSequence: 1,
        threads: snapshot.threads.map((thread, index) =>
          index === 199 ? { ...thread, title: "Updated last thread" } : thread,
        ),
      });
      const after = harness.registry.get(listAtom);
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).not.toBe(before.at(-1));
      expect(after.at(-1)?.title).toBe("Updated last thread");
      expect(harness.registry.get(projectListAtom).at(-1)).toBe(after.at(-1));
      expect(harness.registry.get(firstAtom)).toBe(after[0]);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
    } finally {
      disposeProjectList();
      disposeList();
      harness.registry.dispose();
    }
  });

  it("preserves project memberships on updates and keeps the same thread separate per environment", () => {
    const harness = makeHarness([environmentId, remoteEnvironmentId]);
    const otherThread = {
      ...v2ThreadShell,
      id: ThreadId.make("other-thread"),
      projectId: otherProjectId,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const membershipAtom = harness.threads.environmentThreadRefsByProjectAtom(environmentId);
    const listAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: v2ThreadShell.projectId },
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    try {
      const membership = harness.registry.get(membershipAtom);
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(2);
      expect(before[0]).not.toBe(before[1]);
      expect(before.map((thread) => thread.environmentId)).toEqual([
        remoteEnvironmentId,
        environmentId,
      ]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [v2ThreadShell, { ...otherThread, title: "Changed elsewhere" }],
      });
      expect(harness.registry.get(membershipAtom)).toBe(membership);
      expect(harness.registry.get(listAtom)).toBe(before);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [{ ...v2ThreadShell, projectId: otherProjectId }, otherThread],
      });
      expect(harness.registry.get(listAtom)).toEqual([before[0]]);
      harness.registry.set(harness.snapshotAtom(remoteEnvironmentId), {
        ...v2ShellSnapshot,
        threads: [],
      });
      expect(harness.registry.get(listAtom)).toEqual([]);
    } finally {
      disposeList();
      harness.registry.dispose();
    }
  });
});

it("presents an archived search destination from its own details without changing its archive state", () => {
  const projection = { ...v2Projection, thread: { ...v2Projection.thread, archivedAt: v2Now } };
  const shell = threadDetailToShell(environmentId, projection);
  expect(shell.id).toBe(projection.thread.id);
  expect(shell.archivedAt).not.toBeNull();
  expect(projection.thread.archivedAt).toBe(v2Now);
});

it("lists an agent-created top-level chat in the same project as a user-created chat", () => {
  const harness = makeHarness();
  const created = {
    ...v2ThreadShell,
    id: ThreadId.make("thread:created-independent"),
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    lineage: {
      rootThreadId: ThreadId.make("thread:created-independent"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    latestUserAuthoredMessageAt: null,
  };
  harness.registry.set(harness.snapshotAtom(environmentId), {
    ...v2ShellSnapshot,
    threads: [v2ThreadShell, created],
  });
  expect(
    harness.registry.get(harness.threads.navigationThreadShellsAtom).map((thread) => thread.id),
  ).toContain(created.id);
});
