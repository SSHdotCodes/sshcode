import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { randomUUID } from "../../lib/utils";
import { CommandId } from "@t3tools/contracts";
import {
  scheduledMessageInstant,
  scheduledMessageLocalDateTime,
} from "@t3tools/client-runtime/scheduled-message";
import { useRef, useState } from "react";
import { CalendarClockIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function ScheduleMessageDialog(props: {
  prompt: string;
  disabledReason: string | null;
  onClose: () => void;
  onSchedule: (runAt: string, commandId: CommandId) => Promise<void>;
}) {
  const nowMs = useNowMinuteMs();
  const [when, setWhen] = useState(() => scheduledMessageLocalDateTime(Date.now() + 3_600_000));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [commandId] = useState(() => CommandId.make(randomUUID()));
  const submit = async () => {
    if (pending.current || props.disabledReason) return;
    const runAt = scheduledMessageInstant(when);
    if (runAt === null) {
      setError("Choose a valid date and time in the future.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await props.onSchedule(runAt, commandId);
      props.onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not schedule the message. Your draft is saved.",
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Schedule message</DialogTitle>
          <DialogDescription>
            Steer the agent if it is working, or start a turn if it is idle.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogPanel>
            <div className="space-y-2">
              <Label htmlFor="schedule-message-time">Send on</Label>
              <Input
                id="schedule-message-time"
                type="datetime-local"
                nativeInput
                value={when}
                disabled={saving}
                min={scheduledMessageLocalDateTime(nowMs)}
                onChange={(event) => {
                  setWhen(event.target.value);
                  setError(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {Intl.DateTimeFormat().resolvedOptions().timeZone}. If the environment is offline,
                delivery waits until it returns. You can close the app.
              </p>
            </div>
            <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-sm">
              {props.prompt || "Write a message in the composer first."}
            </div>
            {props.disabledReason || error ? (
              <p role="alert" className="text-sm text-destructive">
                {props.disabledReason ?? error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || props.disabledReason !== null}>
              <CalendarClockIcon />
              {saving ? "Scheduling…" : "Schedule message"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
