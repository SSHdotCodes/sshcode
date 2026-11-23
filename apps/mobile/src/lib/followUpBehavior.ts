import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";

/**
 * What the send button does while a turn is already running: `queue` waits for
 * the turn to finish, `steer` uses the agent's native mid-turn input and queues
 * when unavailable. Steering is the default, as in the Claude Code and Codex apps.
 *
 * Web keeps the same choice in its per-client settings. Mobile has no
 * client-settings sync, so it is stored per device alongside the other
 * composer preferences.
 */
export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "steer";
