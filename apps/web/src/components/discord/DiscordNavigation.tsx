import { CLAUDE_RC_TAB, type EnvironmentMachineKind } from "@t3tools/contracts";
import {
  PanelLeftCloseIcon,
  ChevronDownIcon,
  HomeIcon,
  MonitorIcon,
  TerminalIcon,
  PlusIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "../../lib/utils";
import { useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import type { ChatTabView } from "@t3tools/client-runtime/state/chat-tabs";
import { discordServerIdentity, type discordServers } from "./discordShell.logic";
import { sessionBoxIconUrl } from "../sessionBoxes/sessionBoxIcons";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

export interface DiscordMachine {
  id: string;
  label: string;
  kind: EnvironmentMachineKind;
  connected: boolean;
  connecting?: boolean;
  needsYou: number;
  unread: boolean;
}

function moveRailFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-server]"),
  );
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  event.preventDefault();
  buttons[
    (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
  ]?.focus();
}

export function DiscordServerArt({ tab }: { tab: Pick<ChatTabView, "name" | "icon"> }) {
  const identity = discordServerIdentity(tab.name);
  const source = tab.icon?.kind === "image" ? tab.icon.dataUrl : sessionBoxIconUrl(identity.face);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (tab.icon?.kind === "emoji")
    return (
      <span className="text-2xl" aria-hidden>
        {tab.icon.emoji}
      </span>
    );
  return source === failedSource ? (
    <span
      className="dc-server-initials"
      style={{ "--dc-server-hue": identity.hue } as CSSProperties}
    >
      {identity.initials}
    </span>
  ) : (
    <img
      src={source}
      alt=""
      draggable={false}
      className={tab.icon?.kind === "image" ? "size-full object-cover" : "size-10 object-contain"}
      onError={() => setFailedSource(source)}
    />
  );
}

export function DiscordServerRail({
  servers,
  selected,
  onSelect,
  onCreate,
  onContextMenu,
  home,
  dropTarget,
  ref,
  canCreate,
}: {
  servers: ReturnType<typeof discordServers>;
  selected: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onContextMenu: (tab: ChatTabView, position: { x: number; y: number }) => void;
  home: { unread: boolean; needsYou: number };
  dropTarget: string | null;
  ref: Ref<HTMLDivElement>;
  canCreate: boolean;
}) {
  const { toggleSidebar } = useSidebar();
  const entries = [{ tab: null, ...home }, ...servers];
  return (
    <nav ref={ref} className="dc-server-rail" aria-label="Servers" onKeyDown={moveRailFocus}>
      {entries.map((server, index) => {
        const key = server.tab?.key ?? "";
        const label = server.tab?.name ?? "Home";
        return (
          <div className="dc-server-slot" key={key}>
            {index === 1 ? <div className="dc-rail-separator" /> : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-server={key}
                    data-chat-tab-drop={key}
                    className="dc-server-icon"
                    data-drop-target={dropTarget === key || undefined}
                    data-selected={selected === key}
                    data-unread={server.unread}
                    aria-pressed={selected === key}
                    aria-label={`${label}${server.needsYou ? `, ${server.needsYou} need you` : ""}`}
                    onClick={() => onSelect(key)}
                    onContextMenu={
                      server.tab
                        ? (event) => {
                            event.preventDefault();
                            if (server.tab)
                              onContextMenu(server.tab, { x: event.clientX, y: event.clientY });
                          }
                        : undefined
                    }
                  />
                }
              >
                <span className="dc-server-pill" />
                {server.tab ? <DiscordServerArt tab={server.tab} /> : <HomeIcon size={25} />}
                {server.needsYou > 0 ? (
                  <span className="dc-rail-badge">
                    {server.needsYou > 99 ? "99+" : server.needsYou}
                  </span>
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="right" sideOffset={12}>
                {label}
              </TooltipPopup>
            </Tooltip>
          </div>
        );
      })}
      <div className="dc-server-slot">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-server={CLAUDE_RC_TAB}
                className="dc-server-icon"
                data-selected={selected === CLAUDE_RC_TAB}
                aria-pressed={selected === CLAUDE_RC_TAB}
                aria-label="Terminal"
                onClick={() => onSelect(CLAUDE_RC_TAB)}
              />
            }
          >
            <span className="dc-server-pill" />
            <TerminalIcon size={25} />
          </TooltipTrigger>
          <TooltipPopup side="right" sideOffset={12}>
            Terminal
          </TooltipPopup>
        </Tooltip>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="dc-server-icon dc-add-machine"
              aria-label="Create server"
              disabled={!canCreate}
              onClick={onCreate}
            />
          }
        >
          <PlusIcon size={26} />
        </TooltipTrigger>
        <TooltipPopup side="right">Create server</TooltipPopup>
      </Tooltip>
      <div className="dc-rail-add">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="dc-icon-button"
                aria-label="Collapse main sidebar"
                onClick={toggleSidebar}
              />
            }
          >
            <PanelLeftCloseIcon size={20} />
          </TooltipTrigger>
          <TooltipPopup side="right">Collapse sidebar</TooltipPopup>
        </Tooltip>
      </div>
    </nav>
  );
}

export function DiscordMachineHeader({
  server,
  terminal = false,
  onSettings,
}: {
  server: ChatTabView | undefined;
  terminal?: boolean;
  onSettings: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className="dc-machine-header" />}>
        <span>
          <strong>{terminal ? "Terminal" : (server?.name ?? "Home")}</strong>
          <small>
            {terminal
              ? "Terminal session"
              : server
                ? `${server.threadKeys.size} chats`
                : "Every chat, across your machines"}
          </small>
        </span>
        <ChevronDownIcon size={18} />
      </MenuTrigger>
      <MenuPopup align="start">
        {server ? <MenuItem onClick={onSettings}>Server settings</MenuItem> : null}
        <MenuItem onClick={() => void navigate({ to: "/settings/connections" })}>
          Manage machines
        </MenuItem>
        <MenuItem onClick={() => void navigate({ to: "/settings" })}>Settings</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function DiscordUserPanel({ machine }: { machine: DiscordMachine | undefined }) {
  const navigate = useNavigate();
  return (
    <div className="dc-user-panel">
      <span className="dc-user-avatar">
        <UserRoundIcon size={19} />
        <i data-presence={machine && !machine.connected ? "offline" : "online"} />
      </span>
      <span className="dc-user-identity">
        <strong>You</strong>
        <small>
          {machine
            ? `${machine.label} · ${machine.connected ? "Connected" : "Offline"}`
            : "All machines"}
        </small>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="dc-icon-button"
              aria-label="Settings"
              onClick={() => void navigate({ to: "/settings" })}
            />
          }
        >
          <SettingsIcon size={20} />
        </TooltipTrigger>
        <TooltipPopup side="top">Settings</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * The machine filter as one chip at the end of the read-filter row: a menu of "All
 * machines" and each machine. It names the machine only while one is picked, so the row
 * fits a narrow sidebar.
 */
export function MachineFilterMenu({
  machines,
  selected,
  onSelect,
  className,
}: {
  machines: readonly DiscordMachine[];
  selected: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const picked = machines.find((machine) => machine.id === selected);
  const label = picked?.label ?? "All machines";
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Filter chats by machine: ${label}`}
                  className={cn(
                    // Same chip as the read filters beside it.
                    "inline-flex min-h-6 min-w-0 shrink cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                    picked
                      ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                      : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground data-popup-open:bg-sidebar-row-hover data-popup-open:text-sidebar-foreground",
                    className,
                  )}
                />
              }
            />
          }
        >
          {picked ? (
            <EnvironmentMachineIcon kind={picked.kind} size={13} className="shrink-0" />
          ) : (
            <MonitorIcon size={13} aria-hidden className="shrink-0" />
          )}
          {/* Named only where the row has room; a narrow sidebar shows its icon, filled. */}
          {picked ? (
            <span className="hidden max-w-28 min-w-0 truncate @[300px]:inline">{picked.label}</span>
          ) : null}
          <ChevronDownIcon size={12} aria-hidden className="shrink-0 opacity-60" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-44">
        <MenuRadioGroup value={picked ? picked.id : "all"} onValueChange={onSelect}>
          <MenuRadioItem value="all" closeOnClick>
            <span className="flex min-w-0 items-center gap-1.5">
              <MonitorIcon className="size-3" aria-hidden />
              <span className="min-w-0 truncate">All machines</span>
            </span>
          </MenuRadioItem>
          {machines.map((machine) => (
            <MenuRadioItem key={machine.id} value={machine.id} closeOnClick>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <EnvironmentMachineIcon kind={machine.kind} className="size-3" />
                <span className="min-w-0 truncate">{machine.label}</span>
                {machine.needsYou > 0 ? (
                  <span
                    className="ml-auto pl-2 text-2xs text-muted-foreground tabular-nums"
                    aria-label={`${machine.needsYou} need you`}
                  >
                    {machine.needsYou}
                  </span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
