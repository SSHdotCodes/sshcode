import { useUiMode } from "~/hooks/useTheme";
import { AgentElapsed } from "./AgentElapsed";

/** Lives in the composer dock so progress never moves the transcript. */
export function DiscordTypingIndicator({
  working,
  providerName,
  startedAt,
}: {
  working: boolean;
  providerName: string;
  startedAt: string | null;
}) {
  const [uiMode] = useUiMode();
  if (uiMode !== "discord") return null;
  return (
    <div data-dc-typing-indicator role="status" aria-live="polite">
      {working ? (
        <>
          <span data-dc-typing-dots aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>{providerName}</strong> is working…
          </span>
          {startedAt ? (
            <span data-dc-typing-elapsed aria-hidden="true">
              <AgentElapsed agent={{ status: "running", startedAt, completedAt: null }} />
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
