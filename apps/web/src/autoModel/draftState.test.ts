import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, partializeComposerDraftStoreState } from "../composerDraftStore";
import { updateAutoModelDraft } from "./draftState";
import {
  autoModelAfterManualPick,
  autoModelCanEvaluate,
  EMPTY_AUTO_MODEL_DRAFT,
} from "./autoModel.logic";

const target = scopeThreadRef(EnvironmentId.make("auto-test"), ThreadId.make("draft"));
const initial = useComposerDraftStore.getState();
afterEach(() => useComposerDraftStore.setState(initial, true));

describe("Auto model draft lifetime", () => {
  // What a hand pick in a new chat writes: the explicit selection, then Auto's bookkeeping.
  const pickByHand = () => {
    useComposerDraftStore
      .getState()
      .setModelSelection(
        target,
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        { explicit: true, replaceOptions: true },
      );
    updateAutoModelDraft(target, autoModelAfterManualPick);
  };
  const canEvaluate = () => {
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    return autoModelCanEvaluate({
      enabled: true,
      hasMessages: false,
      busy: false,
      state: draft?.autoModel ?? EMPTY_AUTO_MODEL_DRAFT,
    });
  };
  it("still judges the prompt when a model was picked before typing", () => {
    pickByHand();
    useComposerDraftStore.getState().setPrompt(target, "rename foo to bar in utils.ts");
    expect(canEvaluate()).toBe(true);
  });
  it("stops once a model is picked for a prompt Auto already judged", () => {
    useComposerDraftStore.getState().setPrompt(target, "rename foo to bar in utils.ts");
    updateAutoModelDraft(target, (state) => ({
      ...state,
      difficulty: { tier: "fast", confidence: 0.9 },
    }));
    pickByHand();
    expect(canEvaluate()).toBe(false);
  });
  it("retains dismissal when the prompt is cleared and typed again", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "rename foo to bar");
    updateAutoModelDraft(target, (state) => ({ ...state, dismissed: true }));
    store.setPrompt(target, "");
    store.setPrompt(target, "research the parser");
    expect(store.getComposerDraft(target)?.autoModel?.dismissed).toBe(true);
  });
  it("keeps dismissal and the learning outcome through persistence and hydration", () => {
    useComposerDraftStore.getState().setPrompt(target, "design a parser");
    updateAutoModelDraft(target, (state) => ({
      ...state,
      difficulty: { tier: "big", confidence: 0.9 },
      shown: true,
      dismissed: true,
    }));
    const saved = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const hydrated = useComposerDraftStore.persist.getOptions().merge!(saved, initial);
    useComposerDraftStore.setState(hydrated, true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.autoModel).toMatchObject({
      difficulty: { tier: "big", confidence: 0.9 },
      shown: true,
      dismissed: true,
    });
  });
  it("lets Auto judge again a draft saved with a dismissal from a pick before typing", () => {
    useComposerDraftStore.getState().setPrompt(target, "rename foo to bar in utils.ts");
    updateAutoModelDraft(target, (state) => ({ ...state, dismissed: true }));
    const saved = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    useComposerDraftStore.setState(
      useComposerDraftStore.persist.getOptions().merge!(saved, initial),
      true,
    );
    expect(canEvaluate()).toBe(true);
  });
  it("preserves acceptance and its effort for the eventual first-send record after reload", () => {
    useComposerDraftStore.getState().setPrompt(target, "rename foo to bar");
    const recommendation = {
      tier: "fast" as const,
      confidence: 0.85,
      label: "Fast",
      selection: {
        instanceId: "codex",
        model: "fast",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    };
    updateAutoModelDraft(target, (state) => ({
      ...state,
      difficulty: { tier: "fast", confidence: 0.85 },
      recommendation,
      accepted: true,
      shown: true,
    }));
    const saved = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    useComposerDraftStore.setState(
      useComposerDraftStore.persist.getOptions().merge!(saved, initial),
      true,
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.autoModel).toMatchObject({
      accepted: true,
      shown: true,
      recommendation,
    });
  });
  it("keeps separate drafts separate and removes metadata when the draft is deleted", () => {
    updateAutoModelDraft(target, (state) => ({ ...state, sent: true }));
    const other = scopeThreadRef(target.environmentId, ThreadId.make("other"));
    expect(useComposerDraftStore.getState().getComposerDraft(other)?.autoModel).toBeUndefined();
    useComposerDraftStore.getState().clearDraftThread(target);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
  });
});
