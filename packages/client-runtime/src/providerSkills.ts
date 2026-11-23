import {
  isProviderWorkspaceSnapshotCurrent,
  providerUsesSharedSkills,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type SharedSkillsList,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

const sharedSkillCatalogs = new Map<string, SharedSkillsList>();
const sharedSkillListeners = new Set<() => void>();

export function readSharedSkillsCatalog(environmentId: string): SharedSkillsList | null {
  return sharedSkillCatalogs.get(environmentId) ?? null;
}

export function publishSharedSkillsCatalog(environmentId: string, list: SharedSkillsList): void {
  // Each composer that mounts refetches the list; an unchanged one keeps the cached object so
  // the open chats do not all render again.
  const cached = sharedSkillCatalogs.get(environmentId);
  if (cached !== undefined && Equal.equals(cached, list)) return;
  sharedSkillCatalogs.set(environmentId, list);
  for (const listener of sharedSkillListeners) listener();
}

export function subscribeSharedSkillsCatalog(listener: () => void): () => void {
  sharedSkillListeners.add(listener);
  return () => {
    sharedSkillListeners.delete(listener);
  };
}

function isLibrarySkillPath(libraryRoot: string, skillPath: string): boolean {
  const root = normalizePathSeparators(libraryRoot).replace(/\/+$/, "");
  const target = normalizePathSeparators(skillPath);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * A local plugin publishes `folder:folder`. Claude's additional-directory
 * skill is the plain directory name, which is what `$name` invokes.
 */
function claudePluginPlainName(name: string): string | undefined {
  const trimmed = name.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return trimmed.slice(separator + 1);
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function hasCompleteProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(snapshot && !snapshot.slashCommandsPending);
}

/** A complete snapshot young enough that opening a composer need not rescan. */
export function hasCurrentProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
  nowMs: number,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(
    snapshot &&
    !snapshot.slashCommandsPending &&
    isProviderWorkspaceSnapshotCurrent(snapshot, nowMs),
  );
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
  shared?: {
    readonly catalog: SharedSkillsList | null;
    readonly agentId?: string | null | undefined;
  },
): ServerProvider["skills"] {
  const native = resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
  const catalog = shared?.catalog;
  if (!catalog || !providerUsesSharedSkills(provider, shared?.agentId)) return native;
  const disabled = new Set(
    catalog.skills.filter((skill) => !skill.enabled).map((skill) => skill.name.toLowerCase()),
  );
  const enabledCatalogNames = new Set(
    catalog.skills.filter((skill) => skill.enabled).map((skill) => skill.name.toLowerCase()),
  );
  const claude = provider.driver === "claudeAgent";
  const outside = native.filter((skill) => {
    if (isLibrarySkillPath(catalog.libraryRoot, skill.path)) return false;
    if (!claude) return true;
    const plain = claudePluginPlainName(skill.name);
    return plain === undefined || !enabledCatalogNames.has(plain.toLowerCase());
  });
  const outsideNames = new Set(outside.map((skill) => skill.name.trim().toLowerCase()));
  const kept = native.filter((skill) => {
    if (!isLibrarySkillPath(catalog.libraryRoot, skill.path)) return false;
    const name = skill.name.trim().toLowerCase();
    return !outsideNames.has(name) && !disabled.has(name);
  });
  const present = new Set([...outside, ...kept].map((skill) => skill.name.trim().toLowerCase()));
  const added = catalog.skills.flatMap((skill): ServerProviderSkill[] => {
    if (!skill.enabled || present.has(skill.name.toLowerCase())) return [];
    return [
      {
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        path: skill.path,
        scope: "user",
        enabled: true,
      },
    ];
  });
  return [...outside, ...kept, ...added];
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}
