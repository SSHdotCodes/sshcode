import { NodeId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  applyShellStreamEvent,
  applyShellStreamEvents,
  type ShellStreamEvent,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
} from "./shellReducer.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/example/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/repo.git",
  },
};

const otherIdentity = {
  canonicalKey: "github.com/example/other",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/other.git",
  },
};

describe("applyShellStreamEvents", () => {
  it("matches sequential replay through removals, stale events, archives and reinsertion", () => {
    const original = {
      ...v2ShellSnapshot,
      projects: [{ ...v2Project, repositoryIdentity }],
      threads: [v2ThreadShell, { ...v2ThreadShell, id: ThreadId.make("sibling") }],
      archivedThreads: [{ ...v2ThreadShell, id: ThreadId.make("archived") }],
    };
    const events: ShellStreamEvent[] = Array.from({ length: 500 }, (_, index) => {
      const id = ThreadId.make(`chat-${index % 19}`);
      const sequence = index + 1;
      switch (index % 7) {
        case 0:
          return { kind: "thread.removed", sequence, location: "active", threadId: id };
        case 1:
          return {
            kind: "project.updated",
            sequence,
            project: { ...v2Project, repositoryIdentity: null },
          };
        case 2:
          return {
            kind: "thread.updated",
            sequence: sequence - 3,
            location: "active",
            thread: { ...v2ThreadShell, id },
          };
        case 3:
          return {
            kind: "thread.updated",
            sequence,
            location: "archive",
            thread: { ...v2ThreadShell, id },
          };
        case 4:
          return {
            kind: "thread.removed",
            sequence,
            location: "archive",
            threadId: ThreadId.make("archived"),
          };
        case 5:
          return { kind: "project.removed", sequence, projectId: v2Project.id };
        default:
          return {
            kind: "thread.updated",
            sequence,
            location: "active",
            thread: { ...v2ThreadShell, id, title: `Title ${index}` },
          };
      }
    });
    const sequential = events.reduce(applyShellStreamEvent, original);
    const batched = applyShellStreamEvents(original, events);
    expect(batched).toEqual(sequential);
    expect(batched.threads.find((thread) => thread.id === v2ThreadShell.id)).toBe(v2ThreadShell);
    expect(original.threads).toHaveLength(2);
    expect(original.archivedThreads).toHaveLength(1);
    expect(original.snapshotSequence).toBe(0);
  });

  it("keeps unchanged row arrays and advances the cursor for equal updates", () => {
    const events: ShellStreamEvent[] = [1, 2, 3].map((sequence) => ({
      kind: "thread.updated",
      sequence,
      location: "active",
      thread: { ...v2ThreadShell },
    }));
    const next = applyShellStreamEvents(v2ShellSnapshot, events);
    expect(next.threads).toBe(v2ShellSnapshot.threads);
    expect(next.snapshotSequence).toBe(3);
    expect(applyShellStreamEvents(next, events)).toBe(next);
    expect(applyShellStreamEvents(next, [])).toBe(next);
  });
});

describe("applyShellStreamEvent", () => {
  it("updates a thread in place without moving its siblings", () => {
    const threads = ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) }));
    const updated = { ...threads[1]!, title: "Streaming" };
    const next = applyShellStreamEvent(
      { ...v2ShellSnapshot, threads },
      {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: updated,
      },
    );
    expect(next.threads.map((thread) => thread.id)).toEqual(["a", "b", "c"]);
    expect(next.threads[0]).toBe(threads[0]);
    expect(next.threads[1]).toBe(updated);
    expect(next.threads[2]).toBe(threads[2]);
  });

  it("keeps the thread list and object when an update changes nothing", () => {
    const threads = ["a", "b"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) }));
    const next = applyShellStreamEvent(
      { ...v2ShellSnapshot, threads },
      {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: { ...threads[1]! },
      },
    );
    expect(next.threads).toBe(threads);
    expect(next.snapshotSequence).toBe(1);
  });

  it("ignores stale project updates without mutating the snapshot", () => {
    const snapshotWithProject = {
      ...v2ShellSnapshot,
      snapshotSequence: 4,
      projects: [v2Project],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project.updated",
        sequence,
        project: { ...v2Project, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe(v2Project.title);
    }
  });

  it("applies project updates and removals", () => {
    const updated = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, title: "Updated" },
    });
    expect(updated.projects[0]?.title).toBe("Updated");
    expect(updated.snapshotSequence).toBe(1);

    const removed = applyShellStreamEvent(updated, {
      kind: "project.removed",
      sequence: 2,
      projectId: ProjectId.make(v2Project.id),
    });
    expect(removed.projects).toEqual([]);
  });

  it("keeps prior repositoryIdentity when a delta arrives with null identity", () => {
    const withIdentity = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, repositoryIdentity },
    });
    expect(withIdentity.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);

    const withoutIdentity = applyShellStreamEvent(withIdentity, {
      kind: "project.updated",
      sequence: 2,
      project: { ...v2Project, title: "Still same root", repositoryIdentity: null },
    });
    expect(withoutIdentity.projects[0]?.title).toBe("Still same root");
    expect(withoutIdentity.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("does not keep prior repositoryIdentity after a workspace root move", () => {
    const withIdentity = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, repositoryIdentity },
    });

    const moved = applyShellStreamEvent(withIdentity, {
      kind: "project.updated",
      sequence: 2,
      project: {
        ...v2Project,
        workspaceRoot: "/tmp/other-root",
        repositoryIdentity: null,
      },
    });
    expect(moved.projects[0]?.workspaceRoot).toBe("/tmp/other-root");
    expect(moved.projects[0]?.repositoryIdentity).toBeNull();
  });

  it("merges full snapshot projects without dropping known repositoryIdentity", () => {
    const previous = {
      ...v2ShellSnapshot,
      projects: [{ ...v2Project, repositoryIdentity }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 2,
      projects: [{ ...v2Project, title: "Refreshed", repositoryIdentity: null }],
    });
    expect(next.projects[0]?.title).toBe("Refreshed");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("lets an enrichment frame patch only the box fields of threads the client has", () => {
    const threads = ["a", "b"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) }));
    const previous = { ...v2ShellSnapshot, snapshotSequence: 7, threads };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 7,
        projects: [],
        threads: [
          { ...threads[1]!, title: "Not applied", boxName: "Studio UI", latestRequest: "Pairing" },
          { ...v2ThreadShell, id: ThreadId.make("unknown"), boxName: "Ignored" },
        ],
      },
      { resolvedRepositoryIdentityRoots: [] },
    );
    expect(next.snapshotSequence).toBe(7);
    expect(next.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(next.threads[0]).toBe(threads[0]);
    expect(next.threads[1]).toMatchObject({
      title: threads[1]!.title,
      boxName: "Studio UI",
      latestRequest: "Pairing",
    });
  });

  it("authoritative lower-sequence reset replaces client-ahead structural state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    });

    expect(next.snapshotSequence).toBe(3);
    expect(next.projects[0]?.title).toBe("Server reset");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.threads[0]?.title).toBe("Server thread");
  });

  it("client-ahead survives lower marked enrichment then still resets on unmarked authoritative", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 20,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const serverSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    };

    // Lower-sequence marked enrichment is identity-only and must not replace structure.
    const afterEnrichment = mergeShellSnapshotProjects(previous, serverSnapshot, {
      resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot],
    });
    expect(afterEnrichment.snapshotSequence).toBe(20);
    expect(afterEnrichment.projects[0]?.title).toBe("Client ahead");
    expect(afterEnrichment.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterEnrichment.threads[0]?.title).toBe("Local-only thread");

    // Unmarked authoritative at the same lower sequence still performs the reset.
    const afterAuthoritative = mergeShellSnapshotProjects(afterEnrichment, serverSnapshot);
    expect(afterAuthoritative.snapshotSequence).toBe(3);
    expect(afterAuthoritative.projects[0]?.title).toBe("Server reset");
    expect(afterAuthoritative.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterAuthoritative.threads[0]?.title).toBe("Server thread");
  });

  it("authoritative null retains identity then same-sequence marked enrichment clears it", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const serverSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    };

    const afterAuthoritative = mergeShellSnapshotProjects(previous, serverSnapshot);
    expect(afterAuthoritative.snapshotSequence).toBe(3);
    expect(afterAuthoritative.projects[0]?.title).toBe("Server reset");
    expect(afterAuthoritative.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(afterAuthoritative.threads[0]?.title).toBe("Server thread");

    const afterEnrichment = mergeShellSnapshotProjects(afterAuthoritative, serverSnapshot, {
      resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot],
    });
    expect(afterEnrichment.snapshotSequence).toBe(3);
    expect(afterEnrichment.projects[0]?.title).toBe("Server reset");
    expect(afterEnrichment.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterEnrichment.threads[0]?.title).toBe("Server thread");
  });

  it("takes identity from a lower-sequence enrichment without reverting live thread state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Newest title" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [{ ...v2ThreadShell, title: "Stale title" }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]?.title).toBe("Newest title");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("treats higher-sequence compact enrichment as metadata-only", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Newest title" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 8,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [],
        archivedThreads: [],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]?.title).toBe("Newest title");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("lower-sequence enrichment cannot resurrect empty structural state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 7,
      projects: [],
      threads: [],
      archivedThreads: [],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [v2ThreadShell],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.projects).toEqual([]);
    expect(next.threads).toEqual([]);
  });

  it("resolved null clears identity only for the marked root", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [
          { ...v2Project, repositoryIdentity: null },
          { ...otherProject, repositoryIdentity: null },
        ],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.projects).toHaveLength(2);
    expect(next.projects[0]?.repositoryIdentity).toBeNull();
    expect(next.projects[1]?.repositoryIdentity).toEqual(otherIdentity);
  });

  it("unrelated unresolved roots retain identity in the same enrichment snapshot", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
      threads: [{ ...v2ThreadShell, title: "Current thread" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
        projects: [
          { ...v2Project, repositoryIdentity },
          { ...otherProject, repositoryIdentity: null },
        ],
        threads: [{ ...v2ThreadShell, title: "Stale thread" }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.threads[0]?.title).toBe("Current thread");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.projects[1]?.repositoryIdentity).toEqual(otherIdentity);
  });

  it("clears identity for multiple roots resolved in one enrichment batch", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
        projects: [
          { ...v2Project, repositoryIdentity: null },
          { ...otherProject, repositoryIdentity: null },
        ],
      },
      {
        resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot, otherProject.workspaceRoot],
      },
    );

    expect(next.projects.map((project) => project.repositoryIdentity)).toEqual([null, null]);
  });

  it("does not replace a live identity with one from an unmarked lower-sequence enrichment", () => {
    const liveIdentity = {
      canonicalKey: "github.com/example/live",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/live.git",
      },
    };
    const staleIdentity = {
      canonicalKey: "github.com/example/stale",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/stale.git",
      },
    };
    const next = mergeShellSnapshotProjects(
      {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        projects: [{ ...v2Project, repositoryIdentity: liveIdentity }],
      },
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity: staleIdentity }],
      },
      { resolvedRepositoryIdentityRoots: [] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.projects[0]?.repositoryIdentity).toEqual(liveIdentity);
  });

  it("keeps archive deltas out of the normal shell cache", () => {
    const archived = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.updated",
      sequence: 3,
      location: "archive",
      thread: { ...v2ThreadShell, archivedAt: v2ThreadShell.updatedAt },
    });
    expect(archived.threads).toEqual([]);
    expect(archived.archivedThreads).toEqual([]);

    const active = applyShellStreamEvent(archived, {
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: v2ThreadShell,
    });
    expect(active.threads).toHaveLength(1);
    expect(active.archivedThreads).toEqual([]);
  });

  it("removes a thread from either collection", () => {
    const next = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.removed",
      sequence: 5,
      location: "active",
      threadId: ThreadId.make(v2ThreadShell.id),
    });
    expect(next.threads).toEqual([]);
    expect(next.snapshotSequence).toBe(5);
  });

  it("leaves unknown future events unchanged", () => {
    const next = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "future.event",
      sequence: 99,
    } as never);

    expect(next).toBe(v2ShellSnapshot);
  });
});

describe("reuseUnchangedThreadShells", () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number: 3,
    url: "https://github.com/pingdotgg/t3code/pull/3",
    source: "agent",
    linkedAt: "2026-06-20T00:00:00.000Z",
    snapshot: null,
    stack: null,
  };
  const linked = { ...v2ThreadShell, pullRequests: [link] };
  const other = { ...v2ThreadShell, id: ThreadId.make("thread-other"), title: "Other" };

  it("keeps the previous object for an unchanged row, even without its deferred links", () => {
    const previous = { ...v2ShellSnapshot, threads: [linked, other] };
    const { pullRequests: _links, ...withoutLinks } = linked;
    const next = reuseUnchangedThreadShells(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      threads: [withoutLinks, { ...other, title: "Renamed" }],
    });
    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]).toBe(linked);
    expect(next.threads[1]).not.toBe(other);
    expect(next.threads[1]?.title).toBe("Renamed");
  });

  it("returns the incoming snapshot when no row is unchanged", () => {
    const incoming = { ...v2ShellSnapshot, threads: [{ ...other, title: "Renamed" }] };
    expect(reuseUnchangedThreadShells({ ...v2ShellSnapshot, threads: [other] }, incoming)).toBe(
      incoming,
    );
  });
});

it("syncs comparison membership and its removal through enrichment frames", () => {
  const thread = { ...v2ThreadShell, id: ThreadId.make("compare-a") };
  const otherId = ThreadId.make("compare-b");
  const previous = { ...v2ShellSnapshot, threads: [thread] };
  const comparison = { id: "compare", title: "Build a tool", threadIds: [thread.id, otherId] };
  const next = { ...v2ShellSnapshot, threads: [{ ...thread, comparison }] };
  const joined = mergeShellSnapshotProjects(previous, next, {
    resolvedRepositoryIdentityRoots: [],
  });
  expect(joined.threads[0]?.comparison).toEqual(comparison);
  const ended = mergeShellSnapshotProjects(
    joined,
    { ...v2ShellSnapshot, threads: [{ ...thread, comparison: null }] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(ended.threads[0]?.comparison).toBeNull();
  expect(ended.threads).toHaveLength(1);
});

it("does not repaint older-server rows when comparison metadata is omitted", () => {
  const previous = { ...v2ShellSnapshot, threads: [{ ...v2ThreadShell, comparison: null }] };
  const merged = mergeShellSnapshotProjects(previous, v2ShellSnapshot, {
    resolvedRepositoryIdentityRoots: [],
  });
  expect(merged.threads[0]).toBe(previous.threads[0]);
});

it("opens and closes the first-subagent ask through enrichment frames", () => {
  const thread = { ...v2ThreadShell, id: ThreadId.make("ask") };
  const previous = { ...v2ShellSnapshot, threads: [thread] };
  const asked = mergeShellSnapshotProjects(
    previous,
    { ...v2ShellSnapshot, threads: [{ ...thread, firstSubagentAsk: NodeId.make("task-1") }] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(asked.threads[0]?.firstSubagentAsk).toBe("task-1");
  // The server omits the field once the ask closes.
  const closed = mergeShellSnapshotProjects(
    asked,
    { ...v2ShellSnapshot, threads: [thread] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(closed.threads[0]?.firstSubagentAsk).toBeUndefined();
});

it("updates and removes a recurring schedule through metadata refreshes without replacing live work", () => {
  const thread = {
    ...v2ThreadShell,
    longRunningWork: { monitorCount: 1, backgroundTaskCount: 0, runningSubagentCount: 0 },
  };
  const previous = { ...v2ShellSnapshot, threads: [thread] };
  const nextScheduledRunAt = "2026-11-10T10:00:00Z";
  const added = mergeShellSnapshotProjects(
    previous,
    {
      ...v2ShellSnapshot,
      threads: [{ ...thread, nextScheduledRunAt }],
    },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(added.threads[0]?.nextScheduledRunAt).toBe(nextScheduledRunAt);
  expect(added.threads[0]?.longRunningWork).toBe(thread.longRunningWork);
  const removed = mergeShellSnapshotProjects(
    added,
    {
      ...v2ShellSnapshot,
      threads: [thread],
    },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(removed.threads[0]?.nextScheduledRunAt).toBeNull();
});

it("takes a changed count of running work from a metadata refresh", () => {
  // One of the app's own monitors starts or ends with no transcript event.
  const thread = {
    ...v2ThreadShell,
    longRunningWork: { monitorCount: 0, backgroundTaskCount: 0, runningSubagentCount: 0 },
  };
  const watching = { monitorCount: 1, backgroundTaskCount: 0, runningSubagentCount: 0 };
  const started = mergeShellSnapshotProjects(
    { ...v2ShellSnapshot, threads: [thread] },
    { ...v2ShellSnapshot, threads: [{ ...thread, longRunningWork: watching }] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(started.threads[0]?.longRunningWork).toEqual(watching);
  const ended = mergeShellSnapshotProjects(
    started,
    { ...v2ShellSnapshot, threads: [thread] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(ended.threads[0]?.longRunningWork?.monitorCount).toBe(0);
});

it("takes live progress from a metadata refresh, and clears it when the refresh omits it", () => {
  // A report_progress call (token use High) changes no transcript, so only a refresh carries it.
  const progress = {
    source: "report" as const,
    startedAt: 1_000,
    reportedAt: 61_000,
    stages: [{ title: "Build", status: "active" as const, minutes: 5, startedAt: 1_000 }],
    updates: [{ text: "Building.", at: 61_000 }],
  };
  const reported = mergeShellSnapshotProjects(
    { ...v2ShellSnapshot, threads: [v2ThreadShell] },
    { ...v2ShellSnapshot, threads: [{ ...v2ThreadShell, liveProgress: progress }] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(reported.threads[0]?.liveProgress).toEqual(progress);
  const next = { ...progress, stages: [{ title: "Build", status: "done" as const }] };
  const advanced = mergeShellSnapshotProjects(
    reported,
    { ...v2ShellSnapshot, threads: [{ ...v2ThreadShell, liveProgress: next }] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(advanced.threads[0]?.liveProgress?.stages[0]?.status).toBe("done");
  const cleared = mergeShellSnapshotProjects(
    advanced,
    { ...v2ShellSnapshot, threads: [v2ThreadShell] },
    { resolvedRepositoryIdentityRoots: [] },
  );
  expect(cleared.threads[0]?.liveProgress).toBeUndefined();
});
