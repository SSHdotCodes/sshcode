import type {
  EnvironmentId,
  OrchestrationV2LiveProgress,
  OrchestrationV2ProviderTurnGeneration,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";

/**
 * What the floating pill says. Connection, syncing, and working share one
 * element so the label swaps in place instead of one pill fading out for
 * another. The connection variant is tappable and triggers a reconnect.
 */
export type FloatingWorkingStatus =
  | {
      readonly kind: "working";
      readonly startedAt: string;
      /** The running turn's output speed, once a reply was timed. */
      readonly generation?: OrchestrationV2ProviderTurnGeneration;
      /**
       * Token use High: a bar along the pill's bottom edge and time left in place of the rate;
       * a tap opens the full progress card.
       */
      readonly progress?: {
        readonly value: OrchestrationV2LiveProgress;
        readonly onPress: () => void;
      };
    }
  | { readonly kind: "syncing"; readonly label: string; readonly showSpinner: boolean }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  // The turn settled while background work it started still runs. `waiting`
  // is false when only commands remain, such as a dev server: the agent is done.
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly running: boolean;
      readonly held?: {
        readonly environmentId: EnvironmentId;
        readonly item: PendingBackgroundWorkItem;
      };
      /**
       * Opens the Agents sheet, which also lists monitors with their Stop buttons.
       * Absent when the sheet has no row for the roster (commands, background
       * tasks): the pill then stays informational, as its label already names them.
       */
      readonly onPress?: () => void;
    }
  // A native /goal on an idle thread: paused, blocked, complete, or set.
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  // A task whose thread the server has not created yet: the worktree may
  // still be checking out, so there is no turn to time.
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

/**
 * Whether the Agents sheet has a row for at least one roster entry: it lists
 * turn subagents and monitors, while commands and background tasks are work it
 * can neither show nor stop, so a roster of just those stays informational.
 */
export function backgroundWorkHasAgentsSheetRows(
  items: ReadonlyArray<PendingBackgroundWorkItem>,
): boolean {
  return items.some((item) => item.kind === "subagent" || item.kind === "monitor");
}

/**
 * The pill's connection variant, or null once the environment is connected and
 * the pill is free to report sync and working state instead.
 */
export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}
