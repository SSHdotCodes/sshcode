import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  buildMachinePickerItems,
  findCachedScratchProject,
  machinePickerStatusHint,
  opensScratchDraft,
  resolveDraftOpenFallback,
  resolveDraftProjectSelection,
  resolveDraftScratchFallback,
  resolveEnvironmentProjectMatch,
  resolveIncomingShareRouteAction,
  resolveInitialProjectFallback,
  resolveMachineScratchSelection,
  resolvePendingTaskFallback,
  resolveScratchStart,
  resolveUsualEnvironmentId,
} from "./new-task-project-selection";

describe("scratch compose entry", () => {
  it("routes bare compose, incoming shares, and draft fallbacks through the same scratch flow", () => {
    expect(opensScratchDraft(undefined, 0)).toBe(true);
    expect(opensScratchDraft({ incomingShareId: "shared-images" }, 0)).toBe(true);
    expect(opensScratchDraft({ incomingShareId: ["shared-images"] }, 0)).toBe(true);
    expect(opensScratchDraft({ draftId: "new-task:draft-1" }, 0)).toBe(true);
    expect(
      opensScratchDraft({ incomingShareId: "shared-images", draftId: "new-task:draft-1" }, 0),
    ).toBe(true);
  });

  it("preserves explicit machine picks, legacy pickProject params, prompt links, and nested pushes", () => {
    expect(opensScratchDraft({ pickMachine: "1" }, 0)).toBe(false);
    expect(opensScratchDraft({ incomingShareId: "share", pickMachine: "1" }, 0)).toBe(false);
    expect(opensScratchDraft({ incomingShareId: "share", pickProject: "1" }, 0)).toBe(false);
    expect(opensScratchDraft({ prompt: "hello" }, 0)).toBe(false);
    expect(opensScratchDraft({ repo: "pingdotgg/t3code" }, 0)).toBe(false);
    expect(opensScratchDraft({ incomingShareId: "share" }, 1)).toBe(false);
    expect(opensScratchDraft(undefined, 1)).toBe(false);
  });
});

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    // Without any weaker match the fork is still the first-project fallback.
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });

  it("falls back to the first project on the target so the draft has a key to carry over to", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [makeProject("unrelated", "server"), makeProject("also-unrelated", "server")];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[0]);
    expect(resolveEnvironmentProjectMatch([], selected)).toBeNull();
  });
});

describe("resolveDraftProjectSelection", () => {
  it("preserves an explicit project selection when that project exists", () => {
    const project = makeProject("t3code");
    expect(resolveDraftProjectSelection("environment:t3code", [project])).toEqual({
      kind: "preserve",
    });
  });

  it("falls back to scratch instead of auto-selecting a leftover named project", () => {
    const named = makeProject("alex", "mac", { workspaceRoot: "/Users/alex" });
    expect(resolveDraftProjectSelection(null, [named])).toEqual({ kind: "scratch" });
  });

  it("falls back to scratch when the selected project is missing from the catalog", () => {
    const named = makeProject("t3code");
    expect(resolveDraftProjectSelection("environment:removed", [named])).toEqual({
      kind: "scratch",
    });
  });
});

describe("automatic draft fallbacks", () => {
  const mac = EnvironmentId.make("mac");
  const macScratch = makeProject("scratch-mac", "mac", { workspaceRoot: "/scratch" });
  const namedMac = makeProject("alex", "mac", { workspaceRoot: "/Users/alex" });

  it("resolves scratch fallback to open, create, wait, or machine picker — never projects", () => {
    expect(
      resolveDraftScratchFallback({
        scratchStart: { kind: "open", project: macScratch, refresh: true },
        environmentsSettling: false,
        preserveDraftId: "new-task:1",
      }),
    ).toEqual({
      kind: "open_scratch",
      project: macScratch,
      refresh: true,
      preserveDraftId: "new-task:1",
    });

    expect(
      resolveDraftScratchFallback({
        scratchStart: { kind: "create", environmentId: mac },
        environmentsSettling: false,
        preserveDraftId: "new-task:1",
      }),
    ).toEqual({
      kind: "create_scratch",
      environmentId: mac,
      preserveDraftId: "new-task:1",
    });

    expect(
      resolveDraftScratchFallback({
        scratchStart: { kind: "none" },
        environmentsSettling: true,
        preserveDraftId: "new-task:1",
      }),
    ).toEqual({ kind: "wait" });

    expect(
      resolveDraftScratchFallback({
        scratchStart: { kind: "none" },
        environmentsSettling: false,
        preserveDraftId: "new-task:1",
      }),
    ).toEqual({
      kind: "pick_machine",
      preserveDraftId: "new-task:1",
    });
  });

  it("preserves typed draft content when the draft's project vanished", () => {
    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:keep-me",
        draftOpened: false,
        draftHasProjectStamp: true,
        draftHasContent: true,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "open", project: macScratch, refresh: false },
      }),
    ).toEqual({
      kind: "open_scratch",
      project: macScratch,
      refresh: false,
      preserveDraftId: "new-task:keep-me",
    });

    // When no machine can take a project-less chat, hand the draft id to Choose machine.
    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:keep-me",
        draftOpened: false,
        draftHasProjectStamp: true,
        draftHasContent: true,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "none" },
      }),
    ).toEqual({
      kind: "pick_machine",
      preserveDraftId: "new-task:keep-me",
    });
  });

  it("waits for a draft's project while cold-launch snapshots are still loading", () => {
    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:cold",
        draftOpened: false,
        draftHasProjectStamp: true,
        draftHasContent: true,
        projectsCount: 0,
        environmentsSettling: true,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "none" },
      }),
    ).toEqual({ kind: "wait" });

    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:cold",
        draftOpened: false,
        draftHasProjectStamp: true,
        draftHasContent: true,
        projectsCount: 0,
        environmentsSettling: false,
        hasPendingShellSnapshot: true,
        scratchStart: { kind: "none" },
      }),
    ).toEqual({ kind: "wait" });

    // Once snapshots settle with no projects, stop waiting and create scratch while keeping the draft.
    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:cold",
        draftOpened: false,
        draftHasProjectStamp: true,
        draftHasContent: true,
        projectsCount: 0,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "create", environmentId: mac },
      }),
    ).toEqual({
      kind: "create_scratch",
      environmentId: mac,
      preserveDraftId: "new-task:cold",
    });
  });

  it("opens a fresh project-less draft when the draft itself was already discarded", () => {
    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:gone",
        draftOpened: false,
        draftHasProjectStamp: false,
        draftHasContent: false,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "open", project: macScratch, refresh: true },
      }),
    ).toEqual({
      kind: "open_scratch",
      project: macScratch,
      refresh: true,
      preserveDraftId: null,
    });

    expect(
      resolveDraftOpenFallback({
        draftId: "new-task:ok",
        draftOpened: true,
        draftHasProjectStamp: true,
        draftHasContent: true,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "none" },
      }),
    ).toEqual({ kind: "opened" });
  });

  it("opens a fresh project-less draft when a pending queued task was already sent or deleted", () => {
    expect(
      resolvePendingTaskFallback({
        scratchStart: { kind: "open", project: macScratch, refresh: true },
        environmentsSettling: false,
      }),
    ).toEqual({
      kind: "open_scratch",
      project: macScratch,
      refresh: true,
      preserveDraftId: null,
    });

    expect(
      resolvePendingTaskFallback({
        scratchStart: { kind: "create", environmentId: mac },
        environmentsSettling: false,
      }),
    ).toEqual({
      kind: "create_scratch",
      environmentId: mac,
      preserveDraftId: null,
    });

    expect(
      resolvePendingTaskFallback({
        scratchStart: { kind: "none" },
        environmentsSettling: true,
      }),
    ).toEqual({ kind: "wait" });

    expect(
      resolvePendingTaskFallback({
        scratchStart: { kind: "none" },
        environmentsSettling: false,
      }),
    ).toEqual({
      kind: "pick_machine",
      preserveDraftId: null,
    });
  });

  it("recovers a missing initialProjectRef to scratch on the usual machine or Choose machine", () => {
    expect(
      resolveInitialProjectFallback({
        directProject: namedMac,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "open", project: macScratch, refresh: true },
        preserveDraftId: null,
      }),
    ).toEqual({ kind: "apply", project: namedMac });

    // Cold launch before projects arrive: wait instead of redirecting away.
    expect(
      resolveInitialProjectFallback({
        directProject: null,
        projectsCount: 0,
        environmentsSettling: true,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "none" },
        preserveDraftId: null,
      }),
    ).toEqual({ kind: "wait" });

    // Project missing after catalog loaded: open scratch and keep any existing draft.
    expect(
      resolveInitialProjectFallback({
        directProject: null,
        projectsCount: 2,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "open", project: macScratch, refresh: true },
        preserveDraftId: "new-task:active",
      }),
    ).toEqual({
      kind: "open_scratch",
      project: macScratch,
      refresh: true,
      preserveDraftId: "new-task:active",
    });

    // No machine can take a project-less chat: show Choose machine, never projects.
    expect(
      resolveInitialProjectFallback({
        directProject: null,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
        scratchStart: { kind: "none" },
        preserveDraftId: null,
      }),
    ).toEqual({
      kind: "pick_machine",
      preserveDraftId: null,
    });
  });

  it("handles reserved incoming share destinations without stranding the user on a picker", () => {
    expect(
      resolveIncomingShareRouteAction({
        hasReservedDestination: false,
        reservedDestinationProject: null,
        projectsCount: 0,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
      }),
    ).toEqual({ kind: "none" });

    expect(
      resolveIncomingShareRouteAction({
        hasReservedDestination: true,
        reservedDestinationProject: macScratch,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
      }),
    ).toEqual({ kind: "resume_reserved", project: macScratch });

    expect(
      resolveIncomingShareRouteAction({
        hasReservedDestination: true,
        reservedDestinationProject: null,
        projectsCount: 0,
        environmentsSettling: true,
        hasPendingShellSnapshot: false,
      }),
    ).toEqual({ kind: "wait" });

    expect(
      resolveIncomingShareRouteAction({
        hasReservedDestination: true,
        reservedDestinationProject: null,
        projectsCount: 1,
        environmentsSettling: false,
        hasPendingShellSnapshot: false,
      }),
    ).toEqual({ kind: "release_and_fallback" });
  });
});

describe("machine picker", () => {
  const mac = EnvironmentId.make("mac");
  const tower = EnvironmentId.make("tower");
  const disabled = EnvironmentId.make("old-laptop");
  const cloud = EnvironmentId.make("cloud-vm");
  const scratchOn = (environmentId: string) =>
    makeProject(`scratch-${environmentId}`, environmentId, { workspaceRoot: "/scratch" });
  const isScratchProject = (project: EnvironmentProject) => project.workspaceRoot === "/scratch";

  it("maps every connection phase to a short connected/offline hint", () => {
    expect(machinePickerStatusHint("connected")).toBe("Connected");
    expect(machinePickerStatusHint("connecting")).toBe("Connecting…");
    expect(machinePickerStatusHint("reconnecting")).toBe("Reconnecting…");
    expect(machinePickerStatusHint("offline")).toBe("Offline");
    expect(machinePickerStatusHint("available")).toBe("Offline");
    expect(machinePickerStatusHint("error")).toBe("Offline");
    expect(machinePickerStatusHint("unsupported")).toBe("Client not supported");
  });

  it("lists one row per enabled non-cloud environment with its label and connection hint", () => {
    const items = buildMachinePickerItems({
      environments: [
        {
          environmentId: mac,
          environmentLabel: "Alex's MacBook Pro",
          isEnabled: true,
          connectionState: "connected",
        },
        {
          environmentId: disabled,
          environmentLabel: "Old MacBook",
          isEnabled: false,
          connectionState: "offline",
        },
        {
          environmentId: tower,
          environmentLabel: "Tower",
          isEnabled: true,
          connectionState: "offline",
        },
        {
          environmentId: cloud,
          environmentLabel: "Cloud sandbox",
          isEnabled: true,
          connectionState: "connected",
        },
      ],
      excludedEnvironmentIds: new Set([cloud]),
      selectedEnvironmentId: mac,
    });

    expect(items).toEqual([
      {
        environmentId: mac,
        environmentLabel: "Alex's MacBook Pro",
        connectionState: "connected",
        statusHint: "Connected",
        isSelected: true,
      },
      {
        environmentId: tower,
        environmentLabel: "Tower",
        connectionState: "offline",
        statusHint: "Offline",
        isSelected: false,
      },
    ]);
  });

  it("resolves picking a machine to its project-less chat, never to a named project", () => {
    const projects = [
      makeProject("alex", "mac", { workspaceRoot: "/Users/alex" }),
      makeProject("helper-test", "tower", { workspaceRoot: "/home/user/helper" }),
      scratchOn("mac"),
    ];

    // Connected machine with known scratch opens immediately and refreshes in the background.
    expect(
      resolveMachineScratchSelection({
        environmentId: mac,
        connectionState: "connected",
        offersScratch: true,
        projects,
        isScratchProject,
      }),
    ).toEqual({ kind: "open", project: scratchOn("mac"), refresh: true });

    // Offline machine with known scratch still opens so the draft queues until it returns.
    expect(
      resolveMachineScratchSelection({
        environmentId: mac,
        connectionState: "offline",
        offersScratch: false,
        projects,
        isScratchProject,
      }),
    ).toEqual({ kind: "open", project: scratchOn("mac"), refresh: false });

    // Connected machine without known scratch creates it — ignoring named projects on that machine.
    expect(
      resolveMachineScratchSelection({
        environmentId: tower,
        connectionState: "connected",
        offersScratch: true,
        projects,
        isScratchProject,
      }),
    ).toEqual({ kind: "create", environmentId: tower });

    // Offline machine without known scratch reports offline — never picks the named project.
    expect(
      resolveMachineScratchSelection({
        environmentId: tower,
        connectionState: "offline",
        offersScratch: false,
        projects,
        isScratchProject,
      }),
    ).toEqual({ kind: "unavailable", reason: "offline" });

    // Connected machine without scratch support reports unsupported.
    expect(
      resolveMachineScratchSelection({
        environmentId: tower,
        connectionState: "connected",
        offersScratch: false,
        projects,
        isScratchProject,
      }),
    ).toEqual({ kind: "unavailable", reason: "unsupported" });
  });
});

describe("findCachedScratchProject", () => {
  const scratchOn = (environmentId: string) =>
    makeProject(`scratch-${environmentId}`, environmentId, { workspaceRoot: "/scratch" });
  const isScratchProject = (project: EnvironmentProject) => project.workspaceRoot === "/scratch";
  const environment = (environmentId: string, isEnabled = true) => ({
    environmentId: EnvironmentId.make(environmentId),
    isEnabled,
  });

  it("prefers the selected machine, then any machine that is switched on", () => {
    const projects = [makeProject("repo", "mac"), scratchOn("mac"), scratchOn("studio")];
    expect(
      findCachedScratchProject({
        environments: [environment("mac"), environment("studio")],
        selectedEnvironmentId: EnvironmentId.make("studio"),
        projects,
        isScratchProject,
      })?.id,
    ).toBe("scratch-studio");
    expect(
      findCachedScratchProject({
        environments: [environment("mac"), environment("studio", false)],
        selectedEnvironmentId: EnvironmentId.make("studio"),
        projects,
        isScratchProject,
      })?.id,
    ).toBe("scratch-mac");
  });

  it("never offers a real project in its place", () => {
    expect(
      findCachedScratchProject({
        environments: [environment("mac")],
        selectedEnvironmentId: null,
        projects: [makeProject("repo", "mac")],
        isScratchProject,
      }),
    ).toBeNull();
  });
});

describe("the machine a new chat starts on", () => {
  const mac = EnvironmentId.make("mac");
  const tower = EnvironmentId.make("tower");
  const paired = (...entries: ReadonlyArray<readonly [string, boolean?]>) =>
    entries.map(([environmentId, isEnabled = true]) => ({
      environmentId: EnvironmentId.make(environmentId),
      isEnabled,
    }));
  const chat = (
    environmentId: string,
    createdAt: string,
    options: {
      readonly parent?: string;
      readonly createdBy?: string;
      readonly creationSource?: string;
    } = {},
  ) => ({
    environmentId: EnvironmentId.make(environmentId),
    createdAt,
    lineage: { parentThreadId: options.parent ?? null },
    source: {
      createdBy: options.createdBy ?? "user",
      creationSource: options.creationSource ?? "mobile",
    },
  });
  const scratchOn = (environmentId: string) =>
    makeProject(`scratch-${environmentId}`, environmentId, { workspaceRoot: "/scratch" });
  const isScratchProject = (project: EnvironmentProject) => project.workspaceRoot === "/scratch";
  const projects = [makeProject("repo", "tower"), scratchOn("tower"), scratchOn("mac")];

  it("counts only chats the user started, not subagent, agent or workflow chats", () => {
    expect(
      resolveUsualEnvironmentId({
        // Tower is listed first, so list order alone would pick it.
        environments: paired(["tower"], ["mac"]),
        threads: [
          chat("tower", "2026-11-19T10:00:00.000Z"),
          chat("mac", "2026-11-20T09:00:00.000Z"),
          chat("tower", "2026-11-20T11:00:00.000Z", { parent: "thread-on-mac" }),
          chat("tower", "2026-11-20T12:00:00.000Z", { createdBy: "agent" }),
          chat("tower", "2026-11-20T13:00:00.000Z", { creationSource: "workflows" }),
        ],
      }),
    ).toBe(mac);
  });

  it("stays on the machine most of the latest chats started on, past one chat elsewhere", () => {
    const threads = [
      chat("mac", "2026-11-20T09:00:00.000Z"),
      chat("mac", "2026-11-20T10:00:00.000Z"),
      chat("mac", "2026-11-20T11:00:00.000Z"),
      // The newest chat went to Tower on purpose: the Mac stays the usual machine.
      chat("tower", "2026-11-20T12:00:00.000Z"),
    ];
    expect(
      resolveUsualEnvironmentId({
        environments: paired(["tower"], ["mac"]),
        threads,
      }),
    ).toBe(mac);
    // A tie goes to the machine of the newer chat.
    expect(
      resolveUsualEnvironmentId({
        environments: paired(["tower"], ["mac"]),
        threads: [
          chat("mac", "2026-11-20T09:00:00.000Z"),
          chat("tower", "2026-11-20T12:00:00.000Z"),
        ],
      }),
    ).toBe(tower);
  });

  it("is the first machine switched on when the user has started no chat", () => {
    expect(
      resolveUsualEnvironmentId({
        environments: paired(["studio", false], ["mac"], ["tower"]),
        threads: [chat("tower", "2026-11-20T12:00:00.000Z", { createdBy: "system" })],
      }),
    ).toBe(mac);
    expect(
      resolveUsualEnvironmentId({ environments: paired(["tower", false]), threads: [] }),
    ).toBeNull();
  });

  it("passes over a machine that was removed or switched off", () => {
    const threads = [
      chat("mac", "2026-11-20T09:00:00.000Z"),
      chat("tower", "2026-11-19T09:00:00.000Z"),
    ];
    expect(resolveUsualEnvironmentId({ environments: paired(["tower"]), threads })).toBe(tower);
    expect(
      resolveUsualEnvironmentId({
        environments: paired(["tower"], ["mac", false]),
        threads,
      }),
    ).toBe(tower);
  });

  it("stays on the usual machine while it reconnects and another machine is connected", () => {
    expect(
      resolveScratchStart({
        environments: paired(["tower"], ["mac"]),
        usualEnvironmentId: mac,
        selectedEnvironmentId: tower,
        offersScratch: (environmentId) => environmentId === tower,
        projects,
        isScratchProject,
      }),
    ).toEqual({ kind: "open", project: scratchOn("mac"), refresh: false });
  });

  it("opens the usual machine's project and refreshes its folder when it is connected", () => {
    const start = (knownProjects: ReadonlyArray<EnvironmentProject>) =>
      resolveScratchStart({
        environments: paired(["tower"], ["mac"]),
        usualEnvironmentId: mac,
        selectedEnvironmentId: tower,
        offersScratch: () => true,
        projects: knownProjects,
        isScratchProject,
      });
    expect(start(projects)).toEqual({ kind: "open", project: scratchOn("mac"), refresh: true });
    // Never seen here yet: the connected usual machine makes it.
    expect(start([scratchOn("tower")])).toEqual({ kind: "create", environmentId: mac });
  });

  it("falls back when the usual machine is gone or its project is unknown here", () => {
    const fallback = (input: {
      readonly environments: ReturnType<typeof paired>;
      readonly offersScratch: (environmentId: EnvironmentId) => boolean;
      readonly projects: ReadonlyArray<EnvironmentProject>;
    }) =>
      resolveScratchStart({
        ...input,
        usualEnvironmentId: mac,
        selectedEnvironmentId: null,
        isScratchProject,
      });
    // Removed, or switched off: the connected machine takes it.
    for (const environments of [paired(["tower"]), paired(["tower"], ["mac", false])]) {
      expect(fallback({ environments, offersScratch: () => true, projects })).toEqual({
        kind: "open",
        project: scratchOn("tower"),
        refresh: true,
      });
    }
    // Reconnecting with no project known here: as before, a connected machine.
    expect(
      fallback({
        environments: paired(["tower"], ["mac"]),
        offersScratch: (environmentId) => environmentId === tower,
        projects: [scratchOn("tower")],
      }),
    ).toEqual({ kind: "open", project: scratchOn("tower"), refresh: true });
    // Nothing connected and nothing known: the machine list.
    expect(
      fallback({
        environments: paired(["tower"], ["mac"]),
        offersScratch: () => false,
        projects: [],
      }),
    ).toEqual({ kind: "none" });
  });
});
