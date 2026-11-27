import Storage from "expo-sqlite/kv-store";
import {
  composerBuiltInSlashRecencyKey,
  composerPathWorkspaceKey,
  composerProviderSlashRecencyKey,
  composerRecentRankMap,
  composerRecentTieBreakerPrefix,
  composerSkillRecencyKey,
  orderByComposerRecentUse,
  parseComposerRecentPaths,
  parseComposerRecentUses,
  recordComposerRecentPath,
  recordComposerRecentUse,
  type ComposerRecentPathsByWorkspace,
} from "@t3tools/client-runtime/composer-command-recency";
import { useWithoutBotThreads } from "../bots/state";
import { useThreadPickerShells } from "../../state/entities";
import { formatModelLink } from "@t3tools/shared/modelLinks";
import {
  createModelPickerCatalog,
  type ModelPickerCatalogInput,
} from "@t3tools/client-runtime/model-picker-catalog";
import { DEBUG_COMMAND } from "@t3tools/shared/debugCommand";
import { rankComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import type { ModelOption } from "../../lib/modelOptions";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  ServerProvider,
  SharedSkillsList,
  ThreadId,
  ThreadPullRequestLink,
  WorkflowDefinition,
} from "@t3tools/contracts";
import {
  chatMentionSearchQuery,
  matchComposerThreadItems,
  rankComposerChatMentions,
} from "@t3tools/client-runtime/composerThreadItems";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

const EMPTY_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = [];
const EMPTY_CHAT_MENTION_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  SIDE_CHAT_COMMAND_BY_KIND,
  sideChatKindForDriver,
} from "@t3tools/contracts";
import { Alert } from "react-native";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { pullRequestComposerContext, threadComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import { relativeTime } from "../../lib/time";
import {
  getComposerDraftSnapshot,
  useComposerDraftSelection,
  setComposerDraftContext,
} from "../../state/use-composer-drafts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillUserInvocable,
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { appendComposerDraftAttachments } from "../../state/use-composer-drafts";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useComposerPathSearch,
  useComposerPullRequestSearch,
  useThreadSearch,
} from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsState } from "../workflows/state";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";
import { threadTranscriptComposerAttachment } from "./threadTranscriptAttachment";

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/** A saved insertion wins for its text; a local caret belongs only to its draft owner. */
export function resolveComposerMenuSelection(input: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly inserted: ComposerEditorSelection | null;
  readonly local: ComposerEditorSelection & { readonly ownerKey: string | null };
}): ComposerEditorSelection {
  if (input.inserted) return input.inserted;
  if (input.local.ownerKey !== input.ownerKey) return composerSelectionAtEnd(input.draftMessage);
  const length = input.draftMessage.length;
  return {
    start: Math.max(0, Math.min(input.local.start, length)),
    end: Math.max(0, Math.min(input.local.end, length)),
  };
}

const EMPTY_WORKFLOWS: ReadonlyArray<WorkflowDefinition> = [];

export function buildComposerSlashCommandItems(input: {
  readonly query: string;
  readonly atMessageStart: boolean;
  readonly hasThread: boolean;
  readonly hasCompactableConversation?: boolean;
  /** Whether T3 itself offers /usage-limits for the selected provider. */
  readonly workflowsBeta?: boolean;
  readonly offersUsageLimits?: boolean;
  readonly allowInteractionMode: boolean;
  readonly selectedProviderStatus: Pick<
    ServerProvider,
    "driver" | "slashCommands" | "showInteractionModeToggle"
  > | null;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const allowInteractionMode =
    input.allowInteractionMode && input.selectedProviderStatus?.showInteractionModeToggle !== false;
  const builtIn = [
    {
      id: "cmd:debug",
      type: "slash-command",
      command: DEBUG_COMMAND.name,
      label: "/debug",
      description: DEBUG_COMMAND.description,
    },
    {
      id: "cmd:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch model",
    },
    {
      id: "cmd:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch to plan mode",
    },
    {
      id: "cmd:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch to default mode",
    },
  ] satisfies ComposerCommandItem[];
  const items: ComposerCommandItem[] = builtIn.filter(
    (item) =>
      item.command.includes(query) &&
      (item.command === "debug"
        ? input.atMessageStart
        : item.command === "model" || allowInteractionMode),
  );

  if (
    input.workflowsBeta &&
    input.hasThread &&
    input.atMessageStart &&
    "workflow".includes(query)
  ) {
    items.push({
      id: "cmd:workflow",
      type: "slash-command",
      command: "workflow",
      label: "/workflow",
      description: "Use a workflow in this chat",
    });
  }

  // Providers expand commands only at the start of a message. T3 commands
  // change local state and do not have this restriction.
  if (!input.atMessageStart) return items;
  const sideChatKind = sideChatKindForDriver(input.selectedProviderStatus?.driver);
  const sideChatCommand = sideChatKind === null ? null : SIDE_CHAT_COMMAND_BY_KIND[sideChatKind];
  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (command.name === DEBUG_COMMAND.name || !command.name.toLowerCase().includes(query))
      continue;
    if (command.name === "compact" && !input.hasCompactableConversation) continue;
    // T3's own limits command is answered by the thread composer; New Task has
    // nowhere to show it. A provider's same-named command is left alone.
    if (command.name === USAGE_LIMITS_COMMAND.name && input.offersUsageLimits && !input.hasThread) {
      continue;
    }
    if (
      !input.hasThread &&
      input.selectedProviderStatus?.driver === "codex" &&
      command.name === "feedback"
    ) {
      continue;
    }
    // A side chat (/btw, /side) asks about an existing thread's conversation.
    if (!input.hasThread && command.name === sideChatCommand) continue;
    items.push({
      id: `pcmd:${command.name}`,
      type: "provider-slash-command",
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    });
  }
  return items;
}

const RECENT_COMMANDS_STORAGE_KEY = "t3code:composer-recent-commands:v1";
const RECENT_PATHS_STORAGE_KEY = "t3code:composer-recent-paths:v2";

let cachedMobileRecentCommands: ReadonlyArray<string> | null = null;
let cachedMobileRecentPaths: ComposerRecentPathsByWorkspace | null = null;

function readMobileRecentCommands(): ReadonlyArray<string> {
  if (cachedMobileRecentCommands === null) {
    try {
      cachedMobileRecentCommands = parseComposerRecentUses(
        Storage.getItemSync(RECENT_COMMANDS_STORAGE_KEY),
      );
    } catch {
      cachedMobileRecentCommands = [];
    }
  }
  return cachedMobileRecentCommands;
}

function recordMobileRecentCommand(key: string): ReadonlyArray<string> {
  const current = readMobileRecentCommands();
  const next = recordComposerRecentUse(current, key);
  if (next === current) return current;
  cachedMobileRecentCommands = next;
  try {
    Storage.setItemSync(RECENT_COMMANDS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory copy when kv-store is unavailable.
  }
  return next;
}

function readMobileRecentPaths(): ComposerRecentPathsByWorkspace {
  if (cachedMobileRecentPaths === null) {
    try {
      cachedMobileRecentPaths = parseComposerRecentPaths(
        Storage.getItemSync(RECENT_PATHS_STORAGE_KEY),
      );
    } catch {
      cachedMobileRecentPaths = {};
    }
  }
  return cachedMobileRecentPaths;
}

function recordMobileRecentPath(
  workspaceKey: string,
  path: string,
): ComposerRecentPathsByWorkspace {
  const current = readMobileRecentPaths();
  const next = recordComposerRecentPath(current, workspaceKey, path);
  if (next === current) return current;
  cachedMobileRecentPaths = next;
  try {
    Storage.setItemSync(RECENT_PATHS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory copy when kv-store is unavailable.
  }
  return next;
}

function mobileSlashItemRecencyKey(item: ComposerCommandItem): string {
  if (item.type === "slash-command") return composerBuiltInSlashRecencyKey(item.command);
  if (item.type === "provider-slash-command") {
    return composerProviderSlashRecencyKey(item.command.name);
  }
  if (item.type === "skill") return composerSkillRecencyKey(item.skill.name);
  return item.id;
}

/**
 * Names that start with the query come first, then names containing it, then
 * description-only matches. Empty queries and equal-rank ties prefer recently
 * used commands and skills, then default order (built-ins, provider commands,
 * skills).
 */
export function rankSlashMenuItems(
  items: ReadonlyArray<ComposerCommandItem>,
  query: string,
  recentKeys: ReadonlyArray<string> = [],
): ComposerCommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return orderByComposerRecentUse(items, recentKeys, mobileSlashItemRecencyKey);
  }
  const recentRanks = composerRecentRankMap(recentKeys);
  const rank = (item: ComposerCommandItem) => {
    const name = item.label.replace(/^\//u, "").toLowerCase();
    if (name.startsWith(normalized)) return 0;
    return name.includes(normalized) ? 1 : 2;
  };
  return items
    .map((item, index) => ({
      item,
      index,
      rank: rank(item),
      recentRank: recentRanks.get(mobileSlashItemRecencyKey(item)) ?? Number.POSITIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank || left.recentRank - right.recentRank || left.index - right.index,
    )
    .map(({ item }) => item);
}

/** Keep the workspace search order between match tiers and prefer recent mentions within a tier. */
export function rankComposerPathEntries<T extends { readonly path: string }>(
  entries: ReadonlyArray<T>,
  query: string,
  recentPaths: ReadonlyArray<string>,
): ReadonlyArray<T> {
  if (recentPaths.length === 0 || entries.length < 2) return entries;

  const normalized = query.trim().toLowerCase();
  if (!normalized) return orderByComposerRecentUse(entries, recentPaths, (entry) => entry.path);

  const positionsByScore = new Map<number, number[]>();
  entries.forEach((entry, index) => {
    const path = entry.path.toLowerCase();
    const filename = path.slice(path.lastIndexOf("/") + 1);
    const score = scoreQueryMatch({
      value: normalized.includes("/") ? path : filename,
      query: normalized,
      exactBase: 0,
      prefixBase: 1,
      boundaryBase: 2,
      includesBase: 3,
      ignorePosition: true,
    });
    if (score === null) return;
    const positions = positionsByScore.get(score);
    if (positions) positions.push(index);
    else positionsByScore.set(score, [index]);
  });

  const ordered = [...entries];
  for (const positions of positionsByScore.values()) {
    const ranked = orderByComposerRecentUse(
      positions.map((position) => entries[position]!),
      recentPaths,
      (entry) => entry.path,
    );
    positions.forEach((position, index) => {
      ordered[position] = ranked[index]!;
    });
  }
  return ordered;
}

export function buildComposerModelItems(
  modelOptions: ReadonlyArray<ModelOption>,
  query: string,
  providers: ReadonlyArray<ServerProvider>,
  catalogInput?: Omit<ModelPickerCatalogInput, "providers" | "search" | "selected">,
): ComposerCommandItem[] {
  if (!query.trim()) return [];
  // The picker retains saved selections even when their provider is no longer usable.
  const superseded = modelFamilySupersessions(providers);
  const readyProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.auth.status !== "unauthenticated" &&
          provider.availability !== "unavailable",
      )
      .map((provider) => provider.instanceId),
  );
  const candidates = modelOptions.filter(
    (option) =>
      readyProviderIds.has(option.selection.instanceId) &&
      !option.isUnavailable &&
      !option.isHidden &&
      !option.isLegacy &&
      !superseded.has(
        modelRankingSelectionKey({
          instanceId: option.selection.instanceId,
          model: option.selection.model,
        }),
      ),
  );
  const catalog = createModelPickerCatalog(
    candidates.map((option) => ({
      instanceId: option.selection.instanceId,
      slug: option.selection.model,
      driver: option.providerDriver,
      instanceName: option.providerLabel,
      name: option.label,
      family: option.family,
      subProvider: option.subtitle,
      isLegacy: option.isLegacy,
      option,
    })),
    { ...catalogInput, providers },
  );
  const favorites = new Map(
    (catalogInput?.favorites ?? []).map((ref, index) => {
      const resolved = catalog.resolveFavorite(ref) ?? ref;
      return [JSON.stringify([resolved.instanceId, resolved.slug]), index];
    }),
  );
  const ordered = [...catalog.sources].sort(
    (a, b) =>
      (favorites.get(JSON.stringify([a.instanceId, a.slug])) ?? Infinity) -
      (favorites.get(JSON.stringify([b.instanceId, b.slug])) ?? Infinity),
  );
  return rankComposerModelMentions(
    ordered.map((source) => source.option),
    query,
    (option) => ({
      name: option.label,
      ...(option.subtitle ? { subProvider: option.subtitle } : {}),
      driverKind: option.providerDriver,
      providerDisplayName: option.providerLabel,
    }),
  ).map((option) => ({
    id: `model:${option.key}`,
    type: "model",
    option,
    label: option.label,
    description: option.providerLabel,
  }));
}

/** `@` suggestions: workflows whose name contains every typed word, newest first. */
export function buildComposerWorkflowItems(
  workflows: ReadonlyArray<WorkflowDefinition>,
  query: string,
): ComposerCommandItem[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  return (
    workflows
      .filter((workflow) => words.every((word) => workflow.name.toLowerCase().includes(word)))
      // `filter` returned a new array; Hermes has no `toSorted`.
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)
      .map((workflow) => {
        const agents = workflow.nodes.filter((node) => node.kind === "agent").length;
        return {
          id: `workflow:${workflow.id}`,
          type: "workflow" as const,
          workflow,
          label: workflow.name,
          description: `Workflow · ${agents} ${agents === 1 ? "agent" : "agents"}`,
        };
      })
  );
}

export function resolveComposerCommandSelection(input: {
  readonly draftMessage: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd">;
  readonly item: ComposerCommandItem;
  readonly allowInteractionMode: boolean;
}): {
  readonly text: string;
  readonly cursor: number;
  readonly interactionMode: ProviderInteractionMode | null;
} {
  const { draftMessage, trigger, item } = input;
  if (
    input.allowInteractionMode &&
    item.type === "slash-command" &&
    (item.command === "plan" || item.command === "default")
  ) {
    return {
      ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, ""),
      interactionMode: item.command,
    };
  }

  let replacement = "";
  if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  } else if (item.type === "model") {
    replacement = `${formatModelLink(item.option.selection.instanceId, item.option.selection.model, item.label)} `;
  }
  return {
    ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement),
    interactionMode: null,
  };
}

/** Shared autocomplete for thread composers and unsent new-task drafts. */
export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  sharedSkills,
  threadShells = EMPTY_THREAD_SHELLS,
  currentThreadId = null,
  projectCwd,
  pullRequestProjectId = null,
  pullRequestRepository = null,
  threadPullRequests,
  selectedProviderStatus,
  hasThread,
  hasCompactableConversation,
  offersUsageLimits = false,
  onWorkflow,
  onPickWorkflow,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
  onUsageLimits,
  modelOptions,
  modelProviders,
  modelCatalogInput,
}: {
  readonly modelCatalogInput?: Omit<ModelPickerCatalogInput, "providers" | "search" | "selected">;
  readonly modelOptions?: ReadonlyArray<ModelOption>;
  readonly modelProviders?: ReadonlyArray<ServerProvider>;
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly sharedSkills: SharedSkillsList | null;
  /** Candidates for `@` thread suggestions; the caller reads them from the entity store. */
  readonly threadShells?: ReadonlyArray<EnvironmentThreadShell>;
  /** Left out of `@` thread suggestions: a thread is never context for itself. */
  readonly currentThreadId?: ThreadId | null;
  readonly projectCwd: string | null;
  readonly pullRequestProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  /** The thread's linked pull requests, offered in `#` suggestions from any repository. */
  readonly threadPullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly hasThread: boolean;
  readonly hasCompactableConversation: boolean;
  /** Whether T3 itself offers /usage-limits for the selected provider. */
  readonly onWorkflow?: () => void;
  /** Set while the Workflows beta is on: `@name` attaches that workflow like `/workflow`. */
  readonly onPickWorkflow?: (workflow: WorkflowDefinition, text: string) => void;
  readonly offersUsageLimits?: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  /** Picking /usage-limits is the action itself; the draft keeps nothing of it. */
  readonly onUsageLimits?: () => void;
}) {
  const [localSelection, setLocalSelection] = useState(() => ({
    ownerKey,
    ...composerSelectionAtEnd(draftMessage),
  }));
  const [recentCommands, setRecentCommands] = useState(readMobileRecentCommands);
  const [recentPaths, setRecentPaths] = useState(readMobileRecentPaths);
  const inserted = useComposerDraftSelection(ownerKey, draftMessage);
  const selection = resolveComposerMenuSelection({
    draftMessage,
    ownerKey,
    inserted,
    local: localSelection,
  });
  const setSelection = (next: ComposerEditorSelection) => setLocalSelection({ ownerKey, ...next });
  // Chats on the user's other machines can be mentioned too; they travel as transcripts.
  const { savedConnectionsById } = useSavedRemoteConnections();
  const otherEnvironmentLabel = useCallback(
    (id: EnvironmentId) => savedConnectionsById[id]?.environmentLabel ?? null,
    [savedConnectionsById],
  );
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const onSelectionChange = useCallback(
    (next: ComposerEditorSelection) => {
      setLocalSelection({ ownerKey, ...next });
    },
    [ownerKey],
  );

  const skills = useMemo(
    () =>
      selectedProviderStatus
        ? resolveProviderSkillsForCwd(selectedProviderStatus, projectCwd, {
            catalog: sharedSkills,
            agentId: selectedProviderStatus.badgeLabel,
          })
        : [],
    [projectCwd, selectedProviderStatus, sharedSkills],
  );
  const trigger = useMemo(() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  }, [draftMessage, enabled, selection]);
  const needsWorkspaceCommands = trigger?.kind === "slash-command" || trigger?.kind === "skill";
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const selectedProviderInstanceId = selectedProviderStatus?.instanceId;
  const hasWorkspaceSnapshot = hasCompleteProviderWorkspaceSnapshot(
    selectedProviderStatus,
    projectCwd,
  );
  // The last scan this composer asked for. A request inside the TTL is not
  // repeated, so a client clock ahead of the server's cannot loop rescans.
  const workspaceRefreshKeyRef = useRef<{ key: string; requestedAt: number } | null>(null);
  const [workspaceRefreshRetry, setWorkspaceRefreshRetry] = useState<{
    key: string;
    notBefore: number;
  } | null>(null);
  const workspaceRefreshScopeKey =
    environmentId && projectCwd && selectedProviderInstanceId
      ? `${environmentId}:${selectedProviderInstanceId}:${projectCwd}`
      : null;
  const workspaceSlashCommandsPending =
    selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === projectCwd && snapshot.slashCommandsPending === true,
    ) ?? false;
  useEffect(() => {
    if (
      !needsWorkspaceCommands ||
      !workspaceSlashCommandsPending ||
      !workspaceRefreshRetry ||
      workspaceRefreshRetry.key !== workspaceRefreshScopeKey
    )
      return;
    const timeout = setTimeout(
      () => {
        setWorkspaceRefreshRetry((current) => (current === workspaceRefreshRetry ? null : current));
      },
      Math.max(0, workspaceRefreshRetry.notBefore - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [
    needsWorkspaceCommands,
    workspaceRefreshRetry,
    workspaceRefreshScopeKey,
    workspaceSlashCommandsPending,
  ]);
  const hadWorkspaceSnapshotRef = useRef(false);
  useEffect(() => {
    if (hadWorkspaceSnapshotRef.current && !hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry(null);
    }
    hadWorkspaceSnapshotRef.current = hasWorkspaceSnapshot;
  }, [hasWorkspaceSnapshot]);
  useEffect(() => {
    if (!needsWorkspaceCommands || !environmentId || !projectCwd || !selectedProviderInstanceId)
      return;
    const key = `${environmentId}:${selectedProviderInstanceId}:${projectCwd}`;
    const now = Date.now();
    const lastRequest = workspaceRefreshKeyRef.current;
    if (
      lastRequest?.key === key &&
      now - lastRequest.requestedAt < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS
    )
      return;
    if (hasCurrentProviderWorkspaceSnapshot(selectedProviderStatus, projectCwd, now)) {
      setWorkspaceRefreshRetry(null);
      return;
    }
    const retry = workspaceRefreshRetry;
    if (retry?.key === key && now < retry.notBefore) return;
    const request = { key, requestedAt: now };
    workspaceRefreshKeyRef.current = request;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== request) return;
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry({
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      });
    };
    void refreshProviders({
      environmentId,
      input: {
        instanceId: selectedProviderInstanceId,
        cwd: projectCwd,
        workspaceSnapshotOnly: true,
      },
    }).then((result) => {
      const refreshed =
        result._tag === "Success" &&
        hasCompleteProviderWorkspaceSnapshot(
          result.value.providers.find(
            (provider) => provider.instanceId === selectedProviderInstanceId,
          ),
          projectCwd,
        );
      if (!refreshed) retryLater();
    }, retryLater);
  }, [
    draftMessage,
    environmentId,
    needsWorkspaceCommands,
    projectCwd,
    refreshProviders,
    selectedProviderInstanceId,
    selectedProviderStatus,
    workspaceRefreshRetry,
  ]);

  // Workflows load only while an `@` query is typed, so idle composers stay off the stream.
  const workflowQuery = onPickWorkflow && trigger?.kind === "path" ? trigger.query.trim() : "";
  const mentionWorkflows =
    useEnvironmentQuery(
      workflowQuery && environmentId ? workflowsState({ environmentId, input: {} }) : null,
    ).data?.workflows ?? EMPTY_WORKFLOWS;
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    threadPullRequests,
    query: trigger?.kind === "pull-request" ? trigger.query : null,
  });
  // `@[words with spaces]` describes a chat: the server's search by meaning finds it, and
  // the chat's title and model settle which one is meant.
  const describingChat = trigger?.kind === "chat";
  const chatMentionEnvironmentIds = useMemo(
    () => (describingChat && environmentId ? [environmentId] : EMPTY_CHAT_MENTION_ENVIRONMENTS),
    [describingChat, environmentId],
  );
  const chatMentionSearch = useThreadSearch(
    chatMentionEnvironmentIds,
    trigger?.kind === "chat" ? chatMentionSearchQuery(trigger.query) : "",
  );

  // Bot home chats stay out of chat pickers, as they stay out of every chat list.
  const chatShells = useWithoutBotThreads(threadShells);
  const threadPickerShells = useWithoutBotThreads(useThreadPickerShells(trigger?.kind === "path"));
  const mentionShells = threadPickerShells.length > 0 ? threadPickerShells : chatShells;

  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];

    if (trigger.kind === "pull-request") {
      return pullRequestSearch.entries.map((entry) => ({
        id: `pr:${entry.projectId}:${entry.repository}:${entry.number}`,
        type: "pull-request",
        pullRequest: {
          number: entry.number,
          title: entry.title,
          url: entry.url,
          headBranch: entry.headBranch,
          baseBranch: entry.baseBranch,
          state: entry.state,
          isDraft: entry.isDraft,
        },
        label: `#${entry.number}`,
        description: `${entry.isDraft ? "Draft" : entry.state} · ${
          entry.repository.toLowerCase() === pullRequestRepository?.toLowerCase()
            ? ""
            : `${entry.repository} · `
        }${entry.title}`,
      }));
    }

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const visibleSkills = getProviderSkillsForSlashMenu(skills, true);
      const commandItems = buildComposerSlashCommandItems({
        query: q,
        atMessageStart: trigger.rangeStart === 0,
        hasThread,
        hasCompactableConversation,
        offersUsageLimits,
        workflowsBeta: onWorkflow !== undefined,
        allowInteractionMode: onUpdateInteractionMode !== undefined,
        selectedProviderStatus: selectedProviderStatus
          ? {
              ...selectedProviderStatus,
              slashCommands: getProviderSlashCommandsForSlashMenu(
                resolveProviderSlashCommandsForCwd(selectedProviderStatus, projectCwd),
                visibleSkills,
              ),
            }
          : null,
      });

      // Skills read as commands, as in Claude Code: `/name` and what it does.
      // Picking one still inserts the `$name` token the server dispatches.
      const skillItems = visibleSkills
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `/${skill.displayName ?? skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return rankSlashMenuItems([...commandItems, ...skillItems], q, recentCommands);
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^\p{Sc}+/u,
      });

      if (!normalizedQuery) {
        return orderByComposerRecentUse(enabledSkills, recentCommands, (skill) =>
          composerSkillRecencyKey(skill.name),
        )
          .slice(0, 20)
          .map((skill) => ({
            id: `skill:${skill.name}`,
            type: "skill" as const,
            skill,
            label: skill.displayName ?? skill.name,
            description: skill.shortDescription ?? skill.description ?? "",
          }));
      }

      const recentRanks = composerRecentRankMap(recentCommands);
      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((score): score is number => score !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${composerRecentTieBreakerPrefix(
                recentRanks.get(composerSkillRecencyKey(skill.name)),
              )}\u0000${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (trigger.kind === "chat") {
      return environmentId
        ? rankComposerChatMentions({
            shells: chatShells,
            environmentId,
            excludeThreadId: currentThreadId,
            query: trigger.query,
            matches: chatMentionSearch.matches,
            age: relativeTime,
          })
        : [];
    }

    if (trigger.kind === "path") {
      const threadItems = environmentId
        ? matchComposerThreadItems({
            shells: mentionShells,
            environmentId,
            excludeThreadId: currentThreadId,
            query: trigger.query,
            otherEnvironmentLabel,
          })
        : [];
      const recentPathWorkspaceKey = composerPathWorkspaceKey(environmentId, projectCwd);
      const orderedPathEntries = recentPathWorkspaceKey
        ? rankComposerPathEntries(
            pathSearch.entries,
            trigger.query,
            recentPaths[recentPathWorkspaceKey] ?? [],
          )
        : pathSearch.entries;
      return [
        ...(modelOptions && modelProviders
          ? buildComposerModelItems(modelOptions, trigger.query, modelProviders, modelCatalogInput)
          : []),

        ...buildComposerWorkflowItems(mentionWorkflows, workflowQuery),
        ...threadItems,
        ...orderedPathEntries.map((entry) => {
          const parts = entry.path.split("/");
          return {
            id: `path:${entry.path}`,
            type: "path" as const,
            path: entry.path,
            kind: entry.kind,
            label: parts[parts.length - 1] ?? entry.path,
            description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
          };
        }),
      ];
    }

    return [];
  }, [
    chatMentionSearch.matches,
    mentionShells,
    currentThreadId,
    environmentId,
    otherEnvironmentLabel,
    chatShells,
    hasThread,
    hasCompactableConversation,
    onUpdateInteractionMode,
    modelOptions,
    modelProviders,
    modelCatalogInput,
    pathSearch.entries,
    pullRequestSearch.entries,
    projectCwd,
    recentCommands,
    recentPaths,
    selectedProviderStatus,
    skills,
    trigger,
    offersUsageLimits,
    onWorkflow,
    mentionWorkflows,
    workflowQuery,
  ]);

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;
      if (item.type === "slash-command" && item.command === "workflow" && onWorkflow) {
        setRecentCommands(recordMobileRecentCommand(composerBuiltInSlashRecencyKey(item.command)));
        const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        setSelection({ start: cleared.cursor, end: cleared.cursor });
        onChangeDraftMessage(cleared.text);
        onWorkflow();
        return;
      }
      if (item.type === "workflow") {
        if (trigger.kind !== "path" || !onPickWorkflow) return;
        // The workflow picker writes the draft itself, from the text without the `@` query.
        const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        onPickWorkflow(item.workflow, cleared.text);
        return;
      }
      if (item.type === "thread") {
        if (!ownerKey || (trigger.kind !== "path" && trigger.kind !== "chat")) return;
        if (item.thread.environmentId !== environmentId) {
          // This agent can't read another machine's chat, so its transcript goes along instead.
          const result = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
          onChangeDraftMessage(result.text);
          setSelection({ start: result.cursor, end: result.cursor });
          const ref = item.thread;
          void (async () => {
            const transcript = await loadThreadTranscript({
              environmentId: ref.environmentId,
              input: { threadId: ref.threadId },
            });
            if (transcript._tag !== "Success") {
              Alert.alert(
                "Could not read that chat",
                "Check that its machine is connected, then try again.",
              );
              return;
            }
            try {
              const attachment = await threadTranscriptComposerAttachment(
                ref.environmentId,
                transcript.value,
              );
              if (appendComposerDraftAttachments(ownerKey, [attachment]) > 0) {
                Alert.alert("Too many attachments", "Remove one and try again.");
              }
            } catch (cause) {
              Alert.alert(
                "Could not attach that chat",
                cause instanceof Error ? cause.message : "Try a shorter chat.",
              );
            }
          })();
          return;
        }
        const shell = mentionShells.find(
          (candidate) =>
            candidate.environmentId === item.thread.environmentId &&
            candidate.id === item.thread.threadId,
        );
        if (!shell) return;
        const record = threadComposerContext(item.thread, shell.title);
        const existing = getComposerDraftSnapshot(ownerKey).context?.records ?? [];
        const alreadyAttached = existing.some((entry) => entry.contextId === record.contextId);
        if (!alreadyAttached && existing.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
          Alert.alert(
            "Too many context items",
            "Remove some context from the draft and try again.",
          );
          return;
        }
        const result = replaceTextRange(
          draftMessage,
          trigger.rangeStart,
          trigger.rangeEnd,
          `${formatComposerContextReference(record)} `,
        );
        onChangeDraftMessage(result.text);
        if (!alreadyAttached) {
          const draft = getComposerDraftSnapshot(ownerKey);
          setComposerDraftContext(ownerKey, {
            version: 1,
            records: [...(draft.context?.records ?? []), record],
          });
        }
        setSelection({ start: result.cursor, end: result.cursor });
        return;
      }
      if (item.type === "pull-request") {
        if (
          !ownerKey ||
          trigger.kind !== "pull-request" ||
          !items.some((candidate) => candidate.id === item.id)
        )
          return;
        const record = pullRequestComposerContext(item.pullRequest, uuidv4());
        if (
          (getComposerDraftSnapshot(ownerKey).context?.records.length ?? 0) >=
          COMPOSER_CONTEXT_MAX_RECORDS
        ) {
          Alert.alert(
            "Too many context items",
            "Remove some context from the draft and try again.",
          );
          return;
        }
        const result = replaceTextRange(
          draftMessage,
          trigger.rangeStart,
          trigger.rangeEnd,
          `${formatComposerContextReference(record)} `,
        );
        onChangeDraftMessage(result.text);
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
        setSelection({ start: result.cursor, end: result.cursor });
        return;
      }

      if (
        item.type === "provider-slash-command" &&
        item.command.name === USAGE_LIMITS_COMMAND.name &&
        onUsageLimits
      ) {
        setRecentCommands(
          recordMobileRecentCommand(composerProviderSlashRecencyKey(item.command.name)),
        );
        const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        setSelection({ start: cleared.cursor, end: cleared.cursor });
        onChangeDraftMessage(cleared.text);
        onUsageLimits();
        return;
      }

      if (item.type === "slash-command") {
        setRecentCommands(recordMobileRecentCommand(composerBuiltInSlashRecencyKey(item.command)));
      } else if (item.type === "provider-slash-command") {
        setRecentCommands(
          recordMobileRecentCommand(composerProviderSlashRecencyKey(item.command.name)),
        );
      } else if (item.type === "skill") {
        setRecentCommands(recordMobileRecentCommand(composerSkillRecencyKey(item.skill.name)));
      } else if (item.type === "path") {
        const workspaceKey = composerPathWorkspaceKey(environmentId, projectCwd);
        if (workspaceKey) setRecentPaths(recordMobileRecentPath(workspaceKey, item.path));
      }

      const result = resolveComposerCommandSelection({
        draftMessage,
        trigger,
        item,
        allowInteractionMode:
          onUpdateInteractionMode !== undefined &&
          selectedProviderStatus?.showInteractionModeToggle !== false,
      });
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
      if (result.interactionMode !== null) {
        onUpdateInteractionMode?.(result.interactionMode);
      }
    },
    [
      draftMessage,
      environmentId,
      ownerKey,
      items,
      loadThreadTranscript,
      onChangeDraftMessage,
      onUpdateInteractionMode,
      onUsageLimits,
      onWorkflow,
      onPickWorkflow,
      projectCwd,
      selectedProviderStatus?.showInteractionModeToggle,
      mentionShells,
      trigger,
    ],
  );

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    skills,
    isLoading:
      trigger?.kind === "pull-request"
        ? pullRequestSearch.isPending
        : trigger?.kind === "chat"
          ? chatMentionSearch.isPending
          : pathSearch.isPending,
    error:
      trigger?.kind === "pull-request"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? "Pull requests are unavailable for this project."
          : pullRequestSearch.error
        : null,
    onSelect,
  };
}
