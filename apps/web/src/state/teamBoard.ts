import {
  createTeamBoardAtoms,
  createTeamBoardViewAtoms,
  teamBoardHistory,
  teamBoardPill,
  type TeamBoardSeenStorage,
} from "@t3tools/client-runtime/state/team-board";
import {
  createTeamBoardFixtureSource,
  type TeamBoardFixturePhase,
} from "@t3tools/client-runtime/state/team-board-fixture";
import type { NodeId, ScopedThreadRef, TeamBoardPush } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "./threads";

const SEEN_STORAGE_KEY = "t3code:team-board-seen:v1";
/** Dev QA only: "active", "ended", "readonly" or "repos" swaps the server board for a local fixture. */
const FIXTURE_STORAGE_KEY = "t3code:qa:team-board-fixture";

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const seenStorage: TeamBoardSeenStorage = {
  read: () => localStorageOrNull()?.getItem(SEEN_STORAGE_KEY) ?? null,
  write: (value) => {
    try {
      localStorageOrNull()?.setItem(SEEN_STORAGE_KEY, value);
    } catch {
      // A full or blocked store only costs the new-posts dot after a restart.
    }
  },
};

function devFixturePhase(): TeamBoardFixturePhase | null {
  if (!import.meta.env.DEV) return null;
  const value = localStorageOrNull()?.getItem(FIXTURE_STORAGE_KEY);
  return value === "active" || value === "ended" || value === "readonly" || value === "repos"
    ? value
    : null;
}

const fixturePhase = devFixturePhase();
const subagentsFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make(
    (get) => get(environmentThreadDetails.threadAtom(ref))?.projection.subagents ?? null,
  );
});

export const teamBoardEnvironment = createTeamBoardViewAtoms({
  board: createTeamBoardAtoms(connectionAtomRuntime),
  subagentsAtom: (ref) => subagentsFamily(threadKey(ref)),
  seenStorage,
  fixture: fixturePhase === null ? undefined : createTeamBoardFixtureSource(fixturePhase),
});

/** The live push (optionally one subagent's share), the list of past pushes, or one of them. */
export type TeamBoardView =
  | { readonly kind: "live"; readonly taskId: NodeId | null }
  | { readonly kind: "history" }
  | { readonly kind: "push"; readonly push: TeamBoardPush; readonly taskId: NodeId | null };

/** Which chat's board is open and how; pill, cards and the header menu share it. */
export interface TeamBoardOpenState {
  readonly view: TeamBoardView;
  /** The pill anchors a popover; every other entry opens the same board in a dialog. */
  readonly from: "pill" | "elsewhere";
}
export const teamBoardOpenAtom = Atom.family((_key: string) =>
  Atom.make<TeamBoardOpenState | null>(null),
);

/** Opens the live board: the pill's popover while the pill shows, otherwise a dialog. */
export function openTeamBoard(ref: ScopedThreadRef, taskId: NodeId | null) {
  const pillShown =
    teamBoardPill(
      appAtomRegistry.get(teamBoardEnvironment.summaryAtom(ref)),
      appAtomRegistry.get(teamBoardEnvironment.seenAtom(ref)),
    ) !== null;
  appAtomRegistry.set(teamBoardOpenAtom(threadKey(ref)), {
    view: { kind: "live", taskId },
    from: pillShown ? "pill" : "elsewhere",
  });
}

/** The header menu's entry: past pushes, or the one ended board a server without history keeps. */
export function openTeamBoardHistory(ref: ScopedThreadRef) {
  const history = teamBoardHistory(appAtomRegistry.get(teamBoardEnvironment.summaryAtom(ref)));
  if (history === null) return;
  appAtomRegistry.set(teamBoardOpenAtom(threadKey(ref)), {
    view: history.kind === "pushes" ? { kind: "history" } : { kind: "live", taskId: null },
    from: "elsewhere",
  });
}
