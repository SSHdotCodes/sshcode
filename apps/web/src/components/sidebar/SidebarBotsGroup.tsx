import { BOTS_TITLE } from "@t3tools/client-runtime/state/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { Bot, BotRuntimeState, EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { memo, useMemo, type MouseEvent } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { BotAvatar } from "../bots/BotAvatar";
import { openBotSheet } from "../bots/botRequests";
import {
  useActiveBots,
  useBotActions,
  useBotPresence,
  useBotsRuntime,
  type EnvironmentBot,
} from "../bots/useBots";
import {
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

/**
 * The Bots group at the top of the sidebar, above chats. Shown only while some server has
 * Bots on with a bot; otherwise it renders nothing and opens no bot stream.
 */
export const SidebarBotsGroup = memo(function SidebarBotsGroup() {
  const bots = useActiveBots();
  const environmentIds = useMemo(
    () => [...new Set(bots.map((entry) => entry.environmentId))],
    [bots],
  );
  if (bots.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={BOTS_TITLE}
      className="mt-1.5 border-t border-sidebar-border/60 pt-1"
    >
      <SidebarGroupLabel>{BOTS_TITLE}</SidebarGroupLabel>
      <SidebarMenu>
        {environmentIds.map((environmentId) => (
          <EnvironmentBotRows
            key={environmentId}
            environmentId={environmentId}
            bots={bots.filter((entry) => entry.environmentId === environmentId)}
          />
        ))}
      </SidebarMenu>
    </div>
  );
});

/** One server's rows, sharing that server's bot stream. */
function EnvironmentBotRows(props: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<EnvironmentBot>;
}) {
  const runtime = useBotsRuntime(props.environmentId, true);
  return props.bots.map(({ bot }) => (
    <SidebarBotRow
      key={bot.id}
      environmentId={props.environmentId}
      bot={bot}
      runtime={runtime.byBotId.get(bot.id)}
    />
  ));
}

const SidebarBotRow = memo(function SidebarBotRow(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly runtime: BotRuntimeState | undefined;
}) {
  const { environmentId, bot } = props;
  const presence = useBotPresence(environmentId, bot, props.runtime);
  const { open, setPaused, remove } = useBotActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  const params = buildThreadRouteParams(scopeThreadRef(environmentId, bot.threadId));
  const href = router.buildLocation({ to: "/$environmentId/$threadId", params }).pathname;
  const isActive = useLocation({ select: (location) => location.pathname === href });

  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        [
          { id: "open", label: "Open", icon: "bots" },
          { id: "edit", label: "Edit", icon: "pencil" },
          bot.paused
            ? { id: "resume", label: "Resume", icon: "clock" }
            : { id: "pause", label: "Pause", icon: "clock" },
          {
            id: "delete",
            label: "Delete",
            icon: "trash",
            destructive: true,
            separatorBefore: true,
          },
        ],
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    switch (clicked.value) {
      case "open":
        open(environmentId, bot);
        return;
      case "edit":
        openBotSheet(environmentId, bot.id);
        return;
      case "pause":
      case "resume":
        await setPaused(environmentId, bot, clicked.value === "pause");
        return;
      case "delete":
        await remove(environmentId, bot);
        return;
    }
  };
  const openMenuAt = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    void showMenu(
      event.type === "contextmenu"
        ? { x: event.clientX, y: event.clientY }
        : { x: rect.left, y: rect.bottom + 4 },
    );
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={isActive}
        aria-current={isActive ? "page" : undefined}
        render={
          <Link
            to="/$environmentId/$threadId"
            params={params}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
            onContextMenu={openMenuAt}
          />
        }
      >
        <span className="flex shrink-0">
          <BotAvatar
            color={bot.color}
            size={22}
            state={presence.avatarState}
            ringClassName="stroke-sidebar"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm leading-5 text-sidebar-foreground",
              presence.unread ? "font-semibold" : "font-medium",
            )}
          >
            {bot.name}
          </span>
          <span
            className={cn(
              "truncate text-xs font-normal leading-4",
              presence.status.kind === "needsYou"
                ? "text-warning"
                : "text-sidebar-muted-foreground",
            )}
          >
            {presence.status.label}
          </span>
        </span>
        {presence.unread ? (
          <span
            role="img"
            aria-label="Unread"
            className="size-1.5 shrink-0 rounded-full bg-primary transition-opacity group-hover/menu-item:opacity-0 motion-reduce:transition-none"
          />
        ) : null}
      </SidebarMenuButton>
      <button
        type="button"
        aria-label={`${bot.name} options`}
        onClick={openMenuAt}
        className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 outline-hidden transition-opacity hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/menu-item:opacity-100 motion-reduce:transition-none"
      >
        <EllipsisIcon className="size-4" />
      </button>
    </SidebarMenuItem>
  );
});
