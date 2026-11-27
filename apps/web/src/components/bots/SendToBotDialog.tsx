import { BOT_SEND_NOTE_MAX } from "@t3tools/contracts";
import { useId, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { BotAvatar } from "./BotAvatar";
import { BotSheetHost } from "./BotSheet";
import { closeSendToBot, useSendToBotRequest, type SendToBotRequest } from "./botRequests";
import { environmentBotsAtom, useBotCommand } from "./useBots";

/** Every bot dialog, mounted once at the root. Renders nothing until one is asked for. */
export function BotDialogsHost() {
  return (
    <>
      <BotSheetHost />
      <SendToBotDialogHost />
    </>
  );
}

function SendToBotDialogHost() {
  const request = useSendToBotRequest((state) => state.request);
  if (request === null) return null;
  return <SendToBotDialog key={`${request.threadId}:${request.botId}`} request={request} />;
}

function SendToBotDialog({ request }: { readonly request: SendToBotRequest }) {
  const id = useId();
  const runBotCommand = useBotCommand();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const bot = appAtomRegistry
    .get(environmentBotsAtom(request.environmentId))
    .list.find((candidate) => candidate.id === request.botId);
  const chatTitle =
    readThreadShell({ environmentId: request.environmentId, threadId: request.threadId })?.title ??
    "this chat";
  if (!bot) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    const trimmed = note.trim();
    const result = await runBotCommand(
      request.environmentId,
      {
        type: "send",
        botId: bot.id,
        threadId: request.threadId,
        ...(trimmed ? { note: trimmed } : {}),
      },
      `Couldn't send to ${bot.name}`,
    );
    setSending(false);
    if (!result.ok) return;
    closeSendToBot();
    toastManager.add({ type: "success", title: `Sent to ${bot.name}` });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeSendToBot())}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BotAvatar color={bot.color} size={36} animate={false} />
            <div className="min-w-0">
              <DialogTitle>Send to {bot.name}</DialogTitle>
              <DialogDescription>
                {bot.name} gets a link to {chatTitle}.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            id={`${id}-note`}
            aria-label="Note"
            autoFocus
            value={note}
            maxLength={BOT_SEND_NOTE_MAX}
            placeholder="Add a note (optional)"
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={closeSendToBot}>
            Cancel
          </Button>
          <Button disabled={sending} onClick={() => void send()}>
            Send
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
