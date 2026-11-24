import type { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { PinIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The chat's pinned messages behind a header pin. Picking one jumps to it in
 * the chat. Shows nothing until the chat has a pin.
 */
export function PinnedMessagesControl({
  environmentId,
  threadId,
  discord = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly discord?: boolean;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const pins = thread?.pinnedMessages;
  if (!thread || !pins || pins.length === 0) return null;
  return (
    <PinnedMessagesPopover
      environmentId={environmentId}
      threadId={threadId}
      projectId={thread.projectId}
      pins={pins}
      discord={discord}
    />
  );
}

function PinnedMessagesPopover({
  environmentId,
  threadId,
  projectId,
  pins,
  discord,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly pins: NonNullable<EnvironmentThreadShell["pinnedMessages"]>;
  readonly discord: boolean;
}) {
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const unpin = useAtomCommand(threadEnvironment.pinMessage, "unpin message");
  const [open, setOpen] = useState(false);
  const newestFirst = pins.toReversed();
  const jump = (messageId: MessageId) => {
    setOpen(false);
    appAtomRegistry.set(pendingThreadSearchJumpAtom, {
      environmentId,
      threadId,
      projectId,
      source: "assistant",
      snippet: "",
      messageCreatedAt: null,
      messageId,
    });
  };
  const label = pins.length === 1 ? "1 pinned message" : `${pins.length} pinned messages`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                discord ? (
                  <button type="button" className="dc-icon-button relative" aria-label={label} />
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="relative [-webkit-app-region:no-drag]"
                    aria-label={label}
                  />
                )
              }
            />
          }
        >
          {discord ? <PinIcon size={20} /> : <PinIcon />}
          {pins.length > 1 ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-foreground px-0.5 text-center font-medium text-3xs text-background leading-3.5 tabular-nums"
            >
              {pins.length > 99 ? "99+" : pins.length}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Pinned messages</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <div className="flex max-h-[min(28rem,70vh)] flex-col">
          <p className="px-1 pt-1 pb-2 font-medium text-muted-foreground text-xs">
            Pinned messages
          </p>
          <ul className="-mx-1 flex flex-col gap-0.5 overflow-y-auto">
            {newestFirst.map((pin) => (
              <li key={pin.messageId} className="group/pin relative">
                <button
                  type="button"
                  onClick={() => jump(pin.messageId)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 pr-8 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden"
                >
                  <span
                    className={cn(
                      "line-clamp-2 text-sm leading-snug",
                      !pin.preview && "text-muted-foreground",
                    )}
                  >
                    {pin.preview || "Agent message"}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    Pinned {formatDayAwareTimestamp(pin.pinnedAt, timestampFormat)}
                  </span>
                </button>
                <span className="absolute top-1.5 right-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/pin:opacity-100 pointer-coarse:opacity-100">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Unpin message"
                    title="Unpin"
                    onClick={() =>
                      void unpin({
                        environmentId,
                        input: { threadId, messageId: pin.messageId, pinned: false },
                      })
                    }
                  >
                    <XIcon />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
