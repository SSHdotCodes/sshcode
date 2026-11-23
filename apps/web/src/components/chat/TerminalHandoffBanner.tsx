import { Button } from "../ui/button";
import type { useTerminalHandoff } from "../../state/terminalHandoff";

export function TerminalHandoffBanner({
  handoff,
}: {
  readonly handoff: ReturnType<typeof useTerminalHandoff>;
}) {
  if (!handoff.blockReason) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground"
    >
      <span>
        {handoff.status?.phase === "handing-off"
          ? "Handing this chat to Terminal…"
          : "This chat is open in Terminal."}
      </span>
      {handoff.status?.phase === "in-terminal" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!handoff.allowed}
          onClick={() => void handoff.bringBack()}
        >
          Bring back
        </Button>
      )}
    </div>
  );
}
