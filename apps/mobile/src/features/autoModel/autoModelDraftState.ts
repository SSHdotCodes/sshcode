import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { EMPTY_AUTO_MODEL_DRAFT, type AutoModelDraftState } from "./autoModel.logic";

/**
 * Suggestion state per new-chat draft key. In memory only: an applied suggestion
 * persists as the draft's model, which already ends suggestions for that draft,
 * so after a restart only a dismissal is forgotten.
 */
const autoModelDraftsAtom = Atom.make<Readonly<Record<string, AutoModelDraftState>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:auto-model-drafts"),
);
const autoModelDraftAtom = Atom.family((draftKey: string) =>
  Atom.map(autoModelDraftsAtom, (drafts) => drafts[draftKey] ?? EMPTY_AUTO_MODEL_DRAFT),
);

export function useAutoModelDraft(draftKey: string): AutoModelDraftState {
  return useAtomValue(autoModelDraftAtom(draftKey));
}

export function readAutoModelDraft(draftKey: string): AutoModelDraftState | undefined {
  return appAtomRegistry.get(autoModelDraftsAtom)[draftKey];
}

/** Writes only when `update` returns a new state, so unchanged results never re-render. */
export function updateAutoModelDraft(
  draftKey: string,
  update: (state: AutoModelDraftState) => AutoModelDraftState,
): void {
  const drafts = appAtomRegistry.get(autoModelDraftsAtom);
  const previous = drafts[draftKey] ?? EMPTY_AUTO_MODEL_DRAFT;
  const next = update(previous);
  if (next === previous) return;
  appAtomRegistry.set(autoModelDraftsAtom, { ...drafts, [draftKey]: next });
}

/** The draft was sent or discarded; its next first prompt starts fresh. */
export function clearAutoModelDraft(draftKey: string): void {
  const drafts = appAtomRegistry.get(autoModelDraftsAtom);
  if (!(draftKey in drafts)) return;
  const { [draftKey]: _cleared, ...rest } = drafts;
  appAtomRegistry.set(autoModelDraftsAtom, rest);
}
