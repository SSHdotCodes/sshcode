import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { botStatus, deleteBotConfirm, serverBotsView } from "@t3tools/client-runtime/state/bots";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type Bot,
  type BotOperation,
  type BotOperationResult,
  type BotRuntimeState,
  type BotsView,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { readLocalApi } from "../../localApi";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarThreadStatus, sidebarThreadIsUnread } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { BotAvatarState } from "./BotAvatar";

const OFF_VIEW: BotsView = { enabled: false, list: [], active: false };

/** One server's Settings > Bots. Keeps its identity until the bots themselves change. */
export const environmentBotsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = OFF_VIEW;
  return Atom.make((get): BotsView => {
    const next = serverBotsView(get(serverEnvironment.configValueAtom(environmentId)));
    if (Equal.equals(next, previous)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`bots:view:${environmentId}`));
});

export interface EnvironmentBot {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
}

const NO_BOTS: ReadonlyArray<EnvironmentBot> = [];

/** Every bot on every server that has Bots on, for the sidebar's Bots group. */
const activeBotsAtom = (() => {
  let previous = NO_BOTS;
  return Atom.make((get): ReadonlyArray<EnvironmentBot> => {
    const next: EnvironmentBot[] = [];
    for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
      const view = get(environmentBotsAtom(environmentId));
      if (view.active) for (const bot of view.list) next.push({ environmentId, bot });
    }
    if (
      next.length === previous.length &&
      next.every(
        (entry, index) =>
          entry.bot === previous[index]?.bot &&
          entry.environmentId === previous[index].environmentId,
      )
    ) {
      return previous;
    }
    previous = next.length === 0 ? NO_BOTS : next;
    return previous;
  }).pipe(Atom.withLabel("bots:active"));
})();

export function useEnvironmentBots(environmentId: EnvironmentId | null): BotsView {
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_BOTS_ATOM : environmentBotsAtom(environmentId),
  );
}
const NO_ENVIRONMENT_BOTS_ATOM = Atom.make(OFF_VIEW).pipe(Atom.withLabel("bots:view:none"));

export function useActiveBots(): ReadonlyArray<EnvironmentBot> {
  return useAtomValue(activeBotsAtom);
}

const NO_RUNTIME: ReadonlyMap<string, BotRuntimeState> = new Map();

/**
 * Memory, watches and held updates for one server's bots. The stream opens only while that
 * server has Bots on with a bot, so an install with Bots off never asks for it.
 */
export function useBotsRuntime(
  environmentId: EnvironmentId | null,
  active: boolean,
): {
  readonly byBotId: ReadonlyMap<string, BotRuntimeState>;
  readonly loaded: boolean;
  /** The stream failed before its first state, e.g. a server without bots yet. */
  readonly failed: boolean;
} {
  const query = useEnvironmentQuery(
    active && environmentId !== null
      ? serverEnvironment.botsState({ environmentId, input: {} })
      : null,
  );
  const bots = query.data?.bots;
  const failed = bots === undefined && query.error !== null;
  return useMemo(
    () => ({
      byBotId: bots ? new Map(bots.map((runtime) => [runtime.botId, runtime])) : NO_RUNTIME,
      loaded: bots !== undefined,
      failed,
    }),
    [bots, failed],
  );
}

export interface BotPresence {
  readonly status: ReturnType<typeof botStatus>;
  readonly avatarState: BotAvatarState;
  readonly unread: boolean;
}

/** What a bot is doing, read from its home chat: never its tool activity, only its state. */
export function useBotPresence(
  environmentId: EnvironmentId,
  bot: Bot,
  runtime: BotRuntimeState | undefined,
): BotPresence {
  const ref = useMemo(
    () => scopeThreadRef(environmentId, bot.threadId),
    [environmentId, bot.threadId],
  );
  const shell = useThreadShell(ref);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[`${environmentId}:${bot.threadId}`],
  );
  const threadStatus = shell ? resolveSidebarThreadStatus(shell) : "ready";
  const status = botStatus({
    bot,
    runtime,
    working: threadStatus === "working" || threadStatus === "waiting",
    needsYou: threadStatus === "approval" || threadStatus === "input",
  });
  return {
    status,
    avatarState:
      status.kind === "paused"
        ? "paused"
        : status.kind === "needsYou"
          ? "needsYou"
          : status.kind === "working"
            ? "working"
            : "idle",
    unread: shell !== null && sidebarThreadIsUnread(shell, localLastVisitedAt, true),
  };
}

export type BotCommandResult =
  | { readonly ok: true; readonly result: BotOperationResult }
  | { readonly ok: false };

/** `bots.mutate` for one server. Failures toast with the server's own words. */
export function useBotCommand() {
  const mutate = useAtomCommand(serverEnvironment.mutateBots, { reportFailure: false });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      operation: BotOperation,
      failureTitle: string,
    ): Promise<BotCommandResult> => {
      const result = await mutate({ environmentId, input: operation });
      if (result._tag === "Success") return { ok: true, result: result.value };
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description:
              error instanceof Error && error.message.trim() ? error.message : "Try again.",
          }),
        );
      }
      return { ok: false };
    },
    [mutate],
  );
}

/** Whether this connection may change bots on the server. */
export function useCanEditBots(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    serverEnvironment.mutateBots.permissionAtom(environmentId ?? ("" as EnvironmentId)),
  );
}

/** Open, pause or resume, and delete (after a confirm): the same verbs from every surface. */
export function useBotActions() {
  const router = useRouter();
  const runBotCommand = useBotCommand();
  const open = useCallback(
    (environmentId: EnvironmentId, bot: Bot) =>
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, bot.threadId)),
      }),
    [router],
  );
  const setPaused = useCallback(
    (environmentId: EnvironmentId, bot: Bot, paused: boolean) =>
      runBotCommand(
        environmentId,
        { type: "pause", botId: bot.id, paused },
        paused ? `Couldn't pause ${bot.name}` : `Couldn't resume ${bot.name}`,
      ),
    [runBotCommand],
  );
  const remove = useCallback(
    async (environmentId: EnvironmentId, bot: Bot) => {
      const confirmed = await readLocalApi()?.dialogs.confirm(deleteBotConfirm(bot.name), {
        variant: "destructive",
      });
      if (!confirmed) return;
      const onBotChat =
        router.state.location.pathname ===
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, bot.threadId)),
        }).pathname;
      const result = await runBotCommand(
        environmentId,
        { type: "delete", botId: bot.id },
        `Couldn't delete ${bot.name}`,
      );
      if (result.ok && onBotChat) void router.navigate({ to: "/" });
    },
    [router, runBotCommand],
  );
  return { open, setPaused, remove };
}
