import {
  resolveComposerDraftKey,
  createEmptyThreadDraft,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { EMPTY_AUTO_MODEL_DRAFT, type AutoModelDraftState } from "./autoModel.logic";

/** Update the existing draft so navigation and promotion keep the same first-message outcome. */
export function updateAutoModelDraft(
  target: ScopedThreadRef | DraftId,
  update: (state: AutoModelDraftState) => AutoModelDraftState,
) {
  useComposerDraftStore.setState((store) => {
    const key = resolveComposerDraftKey(store, target);
    if (key === null) return store;
    const draft = store.draftsByThreadKey[key] ?? createEmptyThreadDraft();
    const current = draft.autoModel ?? EMPTY_AUTO_MODEL_DRAFT;
    const next = update(current);
    // Unchanged: no write, so nothing that watches drafts renders or saves.
    if (next === current) return store;
    return {
      draftsByThreadKey: { ...store.draftsByThreadKey, [key]: { ...draft, autoModel: next } },
    };
  });
}
