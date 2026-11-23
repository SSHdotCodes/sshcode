import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";

/**
 * Bare compose, incoming shares, and fallback draft openings skip the machine
 * picker and open a project-less draft directly. Explicit machine picks,
 * prompt links, and nested pushes (`routeIndex !== 0`) open "Choose machine".
 */
export function opensScratchDraft(
  params: Readonly<Record<string, unknown>> | undefined,
  routeIndex: number | undefined,
): boolean {
  return (
    routeIndex === 0 &&
    Object.entries(params ?? {}).every(
      ([key, value]) => key === "incomingShareId" || key === "draftId" || value === undefined,
    )
  );
}

export type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "scratch" };

/**
 * Picks the project on a target environment that corresponds to the project
 * currently selected in the new-task flow, so switching computers follows the
 * same repo. Repository identity is preferred; projects without one (e.g. not
 * yet indexed) fall back to workspace basename, then title. When nothing
 * matches, the first project on the target stands in — the same fallback the
 * render path applies when no key is selected — so the draft always has a
 * concrete key to carry over to.
 */
export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would match nothing meaningful.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // The weaker signals only apply where identity is unknown on at least one
  // side; two known, different repositories never match on a shared basename
  // or title (mirrors the environment list filter in the new-task flow).
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

/**
 * Preserves an explicit loaded project selection (for example a scratch project
 * or a repo silently matched by an `sshcode://new?repo=…` link). Otherwise falls
 * back to a project-less chat on the usual machine rather than auto-picking a
 * named project or showing a project list.
 */
export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  return hasExplicitProjectSelection ? { kind: "preserve" } : { kind: "scratch" };
}

export type DraftFallbackOutcome =
  | { readonly kind: "wait" }
  | {
      readonly kind: "open_scratch";
      readonly project: EnvironmentProject;
      readonly refresh: boolean;
      readonly preserveDraftId: string | null;
    }
  | {
      readonly kind: "create_scratch";
      readonly environmentId: EnvironmentId;
      readonly preserveDraftId: string | null;
    }
  | {
      readonly kind: "pick_machine";
      readonly preserveDraftId: string | null;
    };

/**
 * Common fallback for every broken draft target: open or create a project-less
 * chat on the usual machine, keeping typed draft content when the draft still
 * exists. Only when no machine can take a project-less chat after settling does
 * it show "Choose machine" — never a project list.
 */
export function resolveDraftScratchFallback(input: {
  readonly scratchStart: ScratchStart;
  readonly environmentsSettling: boolean;
  readonly preserveDraftId: string | null;
}): DraftFallbackOutcome {
  if (input.scratchStart.kind === "open") {
    return {
      kind: "open_scratch",
      project: input.scratchStart.project,
      refresh: input.scratchStart.refresh,
      preserveDraftId: input.preserveDraftId,
    };
  }
  if (input.scratchStart.kind === "create") {
    return {
      kind: "create_scratch",
      environmentId: input.scratchStart.environmentId,
      preserveDraftId: input.preserveDraftId,
    };
  }
  if (input.environmentsSettling) {
    return { kind: "wait" };
  }
  return {
    kind: "pick_machine",
    preserveDraftId: input.preserveDraftId,
  };
}

export type DraftOpenFallbackOutcome = { readonly kind: "opened" } | DraftFallbackOutcome;

/**
 * Decides how resuming an existing draft (`draftId`) recovers when its stamped
 * project is missing or the draft was discarded.
 */
export function resolveDraftOpenFallback(input: {
  readonly draftId: string;
  readonly draftOpened: boolean;
  readonly draftHasProjectStamp: boolean;
  readonly draftHasContent: boolean;
  readonly projectsCount: number;
  readonly environmentsSettling: boolean;
  readonly hasPendingShellSnapshot: boolean;
  readonly scratchStart: ScratchStart;
}): DraftOpenFallbackOutcome {
  if (input.draftOpened) {
    return { kind: "opened" };
  }
  if (
    input.draftHasProjectStamp &&
    input.projectsCount === 0 &&
    (input.environmentsSettling || input.hasPendingShellSnapshot)
  ) {
    return { kind: "wait" };
  }
  return resolveDraftScratchFallback({
    scratchStart: input.scratchStart,
    environmentsSettling: input.environmentsSettling,
    preserveDraftId: input.draftHasContent ? input.draftId : null,
  });
}

/**
 * Decides how opening a queued pending task recovers when that task was already
 * delivered or deleted before the draft opened.
 */
export function resolvePendingTaskFallback(input: {
  readonly scratchStart: ScratchStart;
  readonly environmentsSettling: boolean;
}): DraftFallbackOutcome {
  return resolveDraftScratchFallback({
    scratchStart: input.scratchStart,
    environmentsSettling: input.environmentsSettling,
    preserveDraftId: null,
  });
}

export type InitialProjectFallbackOutcome =
  | { readonly kind: "apply"; readonly project: EnvironmentProject }
  | DraftFallbackOutcome;

/**
 * Decides how an `initialProjectRef` route recovers when the requested project
 * is missing from the catalog.
 */
export function resolveInitialProjectFallback(input: {
  readonly directProject: EnvironmentProject | null;
  readonly projectsCount: number;
  readonly environmentsSettling: boolean;
  readonly hasPendingShellSnapshot: boolean;
  readonly scratchStart: ScratchStart;
  readonly preserveDraftId: string | null;
}): InitialProjectFallbackOutcome {
  if (input.directProject !== null) {
    return { kind: "apply", project: input.directProject };
  }
  if (input.projectsCount === 0 && (input.environmentsSettling || input.hasPendingShellSnapshot)) {
    return { kind: "wait" };
  }
  return resolveDraftScratchFallback({
    scratchStart: input.scratchStart,
    environmentsSettling: input.environmentsSettling,
    preserveDraftId: input.preserveDraftId,
  });
}

export type IncomingShareRouteAction =
  | { readonly kind: "none" }
  | { readonly kind: "wait" }
  | { readonly kind: "resume_reserved"; readonly project: EnvironmentProject }
  | { readonly kind: "release_and_fallback" };

/**
 * Decides how `NewTaskRouteScreen` handles an incoming share that already has a
 * reserved destination: resume it if present, wait while shells load, or
 * release the stale reservation and fall back to a project-less chat.
 */
export function resolveIncomingShareRouteAction(input: {
  readonly hasReservedDestination: boolean;
  readonly reservedDestinationProject: EnvironmentProject | null;
  readonly projectsCount: number;
  readonly environmentsSettling: boolean;
  readonly hasPendingShellSnapshot: boolean;
}): IncomingShareRouteAction {
  if (!input.hasReservedDestination) {
    return { kind: "none" };
  }
  if (input.reservedDestinationProject !== null) {
    return { kind: "resume_reserved", project: input.reservedDestinationProject };
  }
  if (input.projectsCount === 0 && (input.environmentsSettling || input.hasPendingShellSnapshot)) {
    return { kind: "wait" };
  }
  return { kind: "release_and_fallback" };
}

export interface MachinePickerEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly isEnabled: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}

export interface MachinePickerItem {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly statusHint: string;
  readonly isSelected: boolean;
}

/** Short connected/offline hint shown beneath each row in "Choose machine". */
export function machinePickerStatusHint(connectionState: EnvironmentConnectionPhase): string {
  switch (connectionState) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "unsupported":
      return "Client not supported";
    case "offline":
    case "available":
    case "error":
      return "Offline";
  }
}

/**
 * Builds the rows for "Choose machine": one row per enabled non-cloud
 * environment, never listing named projects.
 */
export function buildMachinePickerItems(input: {
  readonly environments: ReadonlyArray<MachinePickerEnvironment>;
  readonly excludedEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<MachinePickerItem> {
  const items: MachinePickerItem[] = [];
  for (const environment of input.environments) {
    if (!environment.isEnabled) continue;
    if (input.excludedEnvironmentIds?.has(environment.environmentId)) continue;
    items.push({
      environmentId: environment.environmentId,
      environmentLabel: environment.environmentLabel,
      connectionState: environment.connectionState,
      statusHint: machinePickerStatusHint(environment.connectionState),
      isSelected: environment.environmentId === input.selectedEnvironmentId,
    });
  }
  return items;
}

export type MachineScratchSelection =
  | { readonly kind: "open"; readonly project: EnvironmentProject; readonly refresh: boolean }
  | { readonly kind: "create"; readonly environmentId: EnvironmentId }
  | { readonly kind: "unavailable"; readonly reason: "offline" | "unsupported" };

/**
 * Resolves choosing a machine in "Choose machine" to a project-less chat on
 * that machine. Named projects are never selected.
 */
export function resolveMachineScratchSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly offersScratch: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly isScratchProject: (project: EnvironmentProject) => boolean;
}): MachineScratchSelection {
  const knownScratch =
    input.projects.find(
      (project) => project.environmentId === input.environmentId && input.isScratchProject(project),
    ) ?? null;
  if (knownScratch) {
    return {
      kind: "open",
      project: knownScratch,
      refresh: input.offersScratch,
    };
  }
  if (input.offersScratch) {
    return { kind: "create", environmentId: input.environmentId };
  }
  return {
    kind: "unavailable",
    reason: input.connectionState === "connected" ? "unsupported" : "offline",
  };
}

/** How many of the user's latest chats decide which machine is the usual one. */
const USUAL_MACHINE_WINDOW = 10;

/**
 * The machine new chats start on: the one holding most of the latest
 * USUAL_MACHINE_WINDOW chats the user started from an app (not a subagent,
 * fork, or a chat an agent, workflow or the server made), the latest breaking a
 * tie, among machines still paired and switched on; else the first such machine.
 * One chat started elsewhere on purpose does not move it.
 */
export function resolveUsualEnvironmentId(input: {
  /** Paired machines, in the order the app lists them. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly isEnabled: boolean;
  }>;
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly createdAt: string;
    readonly lineage: { readonly parentThreadId: unknown };
    readonly source: { readonly createdBy: string; readonly creationSource: string };
  }>;
}): EnvironmentId | null {
  const enabled = new Set(
    input.environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => environment.environmentId),
  );
  const started: { readonly environmentId: EnvironmentId; readonly at: number }[] = [];
  for (const thread of input.threads) {
    if (
      !enabled.has(thread.environmentId) ||
      thread.lineage.parentThreadId !== null ||
      thread.source.createdBy !== "user" ||
      (thread.source.creationSource !== "web" && thread.source.creationSource !== "mobile")
    ) {
      continue;
    }
    const at = Date.parse(thread.createdAt);
    if (Number.isFinite(at)) started.push({ environmentId: thread.environmentId, at });
  }
  // Newest first; `started` is this function's own array, so sorting it in place is safe.
  started.sort((left, right) => right.at - left.at);
  const counts = new Map<EnvironmentId, number>();
  let usual: EnvironmentId | null = null;
  for (const chat of started.slice(0, USUAL_MACHINE_WINDOW)) {
    const count = (counts.get(chat.environmentId) ?? 0) + 1;
    counts.set(chat.environmentId, count);
    // Strictly more: on a tie the machine reached first, the newer one, keeps it.
    if (usual === null || count > (counts.get(usual) ?? 0)) usual = chat.environmentId;
  }
  if (usual !== null) return usual;
  return input.environments.find((environment) => environment.isEnabled)?.environmentId ?? null;
}

export type ScratchStart =
  /** A project this device knows; `refresh` asks its machine to re-create the folder. */
  | { readonly kind: "open"; readonly project: EnvironmentProject; readonly refresh: boolean }
  /** A connected machine that offers one but whose project this device has not seen. */
  | { readonly kind: "create"; readonly environmentId: EnvironmentId }
  | { readonly kind: "none" };

/**
 * Where a chat without a project starts. The usual machine keeps it while it
 * reconnects or sleeps whenever this device knows its project: the draft
 * queues and sends once it is back, so a machine that happens to be connected
 * first never takes it. Otherwise a connected machine that offers one (usual,
 * then selected, then the first), then any project known on a machine that is
 * switched on.
 */
export function resolveScratchStart(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly isEnabled: boolean;
  }>;
  readonly usualEnvironmentId: EnvironmentId | null;
  readonly selectedEnvironmentId: EnvironmentId | null;
  /** Connected now and offering threads without a project. */
  readonly offersScratch: (environmentId: EnvironmentId) => boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly isScratchProject: (project: EnvironmentProject) => boolean;
}): ScratchStart {
  const knownScratch = (environmentId: EnvironmentId) =>
    input.projects.find(
      (project) => project.environmentId === environmentId && input.isScratchProject(project),
    ) ?? null;
  const usual = input.environments.find(
    (environment) =>
      environment.isEnabled && environment.environmentId === input.usualEnvironmentId,
  );
  const usualProject = usual ? knownScratch(usual.environmentId) : null;
  if (usual && usualProject) {
    return {
      kind: "open",
      project: usualProject,
      refresh: input.offersScratch(usual.environmentId),
    };
  }
  const connected = input.environments.filter(
    (environment) => environment.isEnabled && input.offersScratch(environment.environmentId),
  );
  const target =
    connected.find((environment) => environment.environmentId === input.usualEnvironmentId) ??
    connected.find((environment) => environment.environmentId === input.selectedEnvironmentId) ??
    connected[0];
  if (target) {
    const project = knownScratch(target.environmentId);
    return project
      ? { kind: "open", project, refresh: true }
      : { kind: "create", environmentId: target.environmentId };
  }
  const cached = findCachedScratchProject(input);
  return cached ? { kind: "open", project: cached, refresh: false } : { kind: "none" };
}

/**
 * The project for threads without a project that this device already knows,
 * on the selected machine first, then on any other machine that is switched
 * on. Offline it still takes a new chat: the draft queues and sends when the
 * machine is back.
 */
export function findCachedScratchProject(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly isEnabled: boolean;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly isScratchProject: (project: EnvironmentProject) => boolean;
}): EnvironmentProject | null {
  const ordered = [
    ...input.environments.filter((entry) => entry.environmentId === input.selectedEnvironmentId),
    ...input.environments.filter((entry) => entry.environmentId !== input.selectedEnvironmentId),
  ];
  for (const environment of ordered) {
    if (!environment.isEnabled) continue;
    const project = input.projects.find(
      (candidate) =>
        candidate.environmentId === environment.environmentId && input.isScratchProject(candidate),
    );
    if (project) return project;
  }
  return null;
}
