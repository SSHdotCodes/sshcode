import { Atom } from "effect/reactivity";
import type { SidebarThreadSummary } from "../types";
import { filterSidebarThreads } from "./Sidebar.logic";

export type SidebarAttentionCounts = { readonly unread: number; readonly needsYou: number };
export const sidebarAttentionSourceAtom = Atom.make<{
  readonly threads: readonly SidebarThreadSummary[];
  readonly visits: Readonly<Record<string, string | undefined>>;
  readonly discordMode: boolean;
}>({ threads: [], visits: {}, discordMode: false }).pipe(Atom.keepAlive);

export const sidebarAttentionCountsAtom = Atom.make((get): SidebarAttentionCounts => {
  const source = get(sidebarAttentionSourceAtom);
  const result = filterSidebarThreads(source.threads, "all", source.visits, source.discordMode);
  return { unread: result.unreadCount, needsYou: result.needsYouCount };
}).pipe(Atom.keepAlive);

export function sidebarAttentionDescription(counts: SidebarAttentionCounts): string {
  return `${counts.unread} unread ${counts.unread === 1 ? "chat" : "chats"}, ${counts.needsYou} ${counts.needsYou === 1 ? "chat needs" : "chats need"} you`;
}

export function SidebarAttentionBadge({ counts }: { counts: SidebarAttentionCounts }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 tabular-nums"
      data-testid="sidebar-collapsed-counts"
    >
      {counts.unread > 0 ? (
        <span className="absolute -top-0.5 -left-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-4xs leading-none font-medium text-primary-foreground">
          {counts.unread > 99 ? "99+" : counts.unread}
        </span>
      ) : null}
      {counts.needsYou > 0 ? (
        <span className="absolute -right-1 -bottom-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-warning-foreground px-0.5 text-4xs leading-none font-medium text-background">
          {counts.needsYou > 99 ? "99+" : counts.needsYou}
        </span>
      ) : null}
    </span>
  );
}
