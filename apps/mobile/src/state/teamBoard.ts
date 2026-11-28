import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createTeamBoardAtoms,
  createTeamBoardViewAtoms,
  type TeamBoardSeenStorage,
} from "@t3tools/client-runtime/state/team-board";
import {
  createTeamBoardFixtureSource,
  type TeamBoardFixturePhase,
} from "@t3tools/client-runtime/state/team-board-fixture";
import Storage from "expo-sqlite/kv-store";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";

const SEEN_STORAGE_KEY = "t3code:team-board-seen:v1";

const seenStorage: TeamBoardSeenStorage = {
  read: () => {
    try {
      return Storage.getItemSync(SEEN_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write: (value) => {
    try {
      Storage.setItemSync(SEEN_STORAGE_KEY, value);
    } catch {
      // A failed write only costs the new-posts dot after a restart.
    }
  },
};

/** Dev QA only: Metro started with EXPO_PUBLIC_QA_TEAM_BOARD_FIXTURE swaps in a local board. */
function devFixturePhase(): TeamBoardFixturePhase | null {
  if (!__DEV__) return null;
  const value = process.env.EXPO_PUBLIC_QA_TEAM_BOARD_FIXTURE;
  return value === "active" ||
    value === "ended" ||
    value === "readonly" ||
    value === "repos" ||
    value === "team"
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
