import type { ServerProvider } from "@t3tools/contracts";
import {
  type AccountSelection,
  type AccountStanding,
  accountPickReason,
  pickAccountForNewSession,
} from "@t3tools/shared/accountBalance";

const ROOM: Record<AccountStanding["state"], number> = { open: 3, unknown: 2, tight: 1, out: 0 };

/**
 * The user's other account of the same provider that should run a new session
 * of `model` in place of `current`. Two accounts that share their chats are
 * one provider to the agent that starts work on them, so the work goes where
 * `pickAccountForNewSession` would start one of the user's own new chats.
 * An account the agent named itself is its choice: it is kept while it can
 * take the work, and left only once it is out or refusing on a usage limit.
 * With balancing off the caller keeps its account, including any refusal.
 */
export function preferSiblingAccount(input: {
  readonly current: ServerProvider;
  /** Accounts the caller would accept in its place; unrelated ones are ignored. */
  readonly candidates: ReadonlyArray<ServerProvider>;
  readonly model: string;
  readonly options?: AccountSelection["options"];
  readonly accepts?: (provider: ServerProvider) => boolean;
  /** `current` is refusing work because it ran into a usage limit. */
  readonly limitReached: boolean;
  /** The agent asked for `current` by its id, rather than inheriting or leaving it open. */
  readonly named?: boolean;
  /** The user's `balanceAccounts` setting. */
  readonly balance: boolean;
  readonly now: number;
}): { readonly provider: ServerProvider; readonly notice: string } | undefined {
  if (!input.balance) return undefined;
  const { current } = input;
  const pick = pickAccountForNewSession(
    [current, ...input.candidates],
    { instanceId: current.instanceId, model: input.model, options: input.options },
    { now: input.now, accepts: input.accepts },
  );
  if (pick === null) return undefined;
  const asked = pick.standings.find((entry) => entry.instanceId === current.instanceId);
  if (input.named && !input.limitReached && asked?.state !== "out") return undefined;
  // The limit shows in no figure: any sibling not known to be out is the better place.
  const unseenLimit = input.limitReached && asked?.state !== "out";
  let instanceId: string = pick.instanceId;
  if (unseenLimit && instanceId === current.instanceId) {
    let best: AccountStanding | undefined;
    for (const candidate of pick.standings) {
      if (candidate.instanceId === current.instanceId || candidate.state === "out") continue;
      const room = best === undefined ? 1 : ROOM[candidate.state] - ROOM[best.state];
      if (room > 0 || (room === 0 && candidate.spare > best!.spare)) best = candidate;
    }
    if (best) instanceId = best.instanceId;
  }
  const provider = input.candidates.find((candidate) => candidate.instanceId === instanceId);
  if (!provider) return undefined;

  const nameOf = (id: string) =>
    (id === current.instanceId
      ? current
      : input.candidates.find((candidate) => candidate.instanceId === id)
    )?.displayName ?? id;
  const reason = unseenLimit
    ? `${nameOf(current.instanceId)} reached its usage limit`
    : (accountPickReason(pick, nameOf) ??
      (current.auth.status === "unauthenticated"
        ? `${nameOf(current.instanceId)} is signed out`
        : null));
  return {
    provider,
    notice: `Started on ${nameOf(instanceId)}${reason === null ? "" : `: ${reason}`}.`,
  };
}
