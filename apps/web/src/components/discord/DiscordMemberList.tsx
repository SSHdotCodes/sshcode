import { cn } from "../../lib/utils";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { TerminalIcon, UserRoundIcon, RadioIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useThreadShells } from "../../state/entities";
import { useThreadFamily } from "../../state/threads";
import { environmentServerConfigsAtom } from "../../state/server";
import { deriveProviderEntriesByEnvironment } from "../../providerInstances";
import { ProviderInstanceIcon, providerTextColor } from "../chat/ProviderInstanceIcon";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import {
  buildDiscordThreadTree,
  flattenDiscordThreadTree,
  nestDiscordThreads,
  threadNeedsYouCount,
} from "./discordShell.logic";

function presence(thread: EnvironmentThreadShell) {
  // The list belongs to the open chat, so the server's visit record is enough.
  if (threadNeedsYouCount(thread, undefined) > 0) return "needsYou";
  const status = resolveSidebarThreadStatus(thread);
  return status === "working" ? "online" : status === "waiting" ? "idle" : "offline";
}

export function DiscordMemberList({
  threadRef,
  onOpenThread,
  dialog = false,
}: {
  dialog?: boolean;
  threadRef: ScopedThreadRef;
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const threads = useThreadShells();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const providers = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...configs].map(([id, config]) => [id, config.providers, config.settings] as const),
      ),
    [configs],
  );
  const main = threads.find(
    (thread) =>
      thread.environmentId === threadRef.environmentId && thread.id === threadRef.threadId,
  );
  useThreadFamily(threadRef.environmentId, main?.lineage.rootThreadId ?? threadRef.threadId);
  const participants = useMemo(() => {
    if (!main) return [];
    const children = nestDiscordThreads(
      threads.filter((thread) => thread.archivedAt === null),
    ).children;
    return flattenDiscordThreadTree(buildDiscordThreadTree(main, children, new Set(), () => true));
  }, [threads, main]);
  const backgroundTasks = (main?.pendingBackgroundTasks ?? []).filter(
    (task) =>
      !(
        task.kind === "subagent" &&
        task.childThreadId &&
        participants.some((thread) => thread.id === task.childThreadId)
      ),
  );
  const groups = ["needsYou", "online", "idle", "offline"] as const;
  const labels = { needsYou: "Needs you", online: "Working", idle: "Idle", offline: "Offline" };
  return (
    <aside
      className="dc-members"
      style={dialog ? { flex: "0 1 auto", maxHeight: "70dvh" } : undefined}
      data-dc-members-dialog={dialog || undefined}
      aria-label="Chat members"
    >
      <h3>You · 1</h3>
      <div className="dc-member">
        <span className="dc-member-avatar">
          <UserRoundIcon size={18} />
          <i data-presence="online" />
        </span>
        <span className="dc-member-copy">
          <span className="dc-member-name">You</span>
          <small>Online</small>
        </span>
      </div>
      {groups.map((group) => {
        const members = participants.filter((thread) => presence(thread) === group);
        if (members.length === 0) return null;
        return (
          <section key={group}>
            <h3>
              {labels[group]} · {members.length}
            </h3>
            {members.map((thread) => {
              const provider = providers
                .get(thread.environmentId)
                ?.get(thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId);
              const name = provider?.displayName ?? thread.runtime?.providerName ?? "Agent";
              const isMain = thread.id === threadRef.threadId;
              const activity =
                group === "needsYou"
                  ? "Needs you"
                  : (thread.source.currentStep?.detail ??
                    (group === "online"
                      ? "Working…"
                      : group === "idle"
                        ? "Waiting for background work"
                        : thread.latestRun === null
                          ? "Ready"
                          : "Finished"));
              return (
                <button
                  type="button"
                  key={thread.id}
                  className="dc-member"
                  aria-label={isMain ? `${name}, ${activity}` : `Open ${thread.title}, ${activity}`}
                  onClick={() => onOpenThread(scopeThreadRef(thread.environmentId, thread.id))}
                >
                  <span className="dc-member-avatar">
                    {provider ? (
                      <ProviderInstanceIcon
                        driverKind={provider.driverKind}
                        displayName={provider.displayName}
                        className="size-5"
                      />
                    ) : (
                      <TerminalIcon size={18} />
                    )}
                    <i data-presence={group} />
                  </span>
                  <span className="dc-member-copy">
                    <span
                      className={cn(
                        "dc-member-name",
                        provider && providerTextColor(provider.driverKind).className,
                      )}
                      style={provider ? providerTextColor(provider.driverKind).style : undefined}
                    >
                      <span>{isMain ? name : thread.title}</span>
                      <span className="dc-app-tag">APP</span>
                    </span>
                    <small>
                      {isMain ? `${thread.modelSelection.model} · ${activity}` : activity}
                    </small>
                  </span>
                </button>
              );
            })}
          </section>
        );
      })}
      {backgroundTasks.length > 0 ? (
        <section>
          <h3>Background · {backgroundTasks.length}</h3>
          {backgroundTasks.map((task) => (
            <div className="dc-member" key={task.taskId}>
              <span className="dc-member-avatar">
                {task.kind === "monitor" ? <RadioIcon size={18} /> : <TerminalIcon size={18} />}
                <i data-presence="online" />
              </span>
              <span className="dc-member-copy">
                <span className="dc-member-name">
                  {task.kind === "monitor"
                    ? "Monitor"
                    : task.kind === "command"
                      ? "Command"
                      : "Background task"}
                </span>
                <small>{task.description ?? task.taskId}</small>
              </span>
            </div>
          ))}
        </section>
      ) : null}
    </aside>
  );
}
