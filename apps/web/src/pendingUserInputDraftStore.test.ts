import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  setPendingUserInputComposerAnswer,
  usePendingUserInputDraftStore,
} from "./pendingUserInputDraftStore";

const key = JSON.stringify(["env", "thread-a", "request-1"]);

afterEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  usePendingUserInputDraftStore.setState({
    answersByRequestKey: {},
    questionIndexByRequestKey: {},
  });
});

describe("pending user input drafts", () => {
  it("keeps a half-answered card outside any one chat view", () => {
    const { setAnswersByRequestKey, setQuestionIndexByRequestKey } =
      usePendingUserInputDraftStore.getState();
    setAnswersByRequestKey((existing) => ({
      ...existing,
      [key]: { q1: { selectedOptionValues: ["Switching chats"] } },
    }));
    setQuestionIndexByRequestKey((existing) => ({ ...existing, [key]: 1 }));
    // The chat view unmounts on a chat switch; the store, and the answers, stay.
    const state = usePendingUserInputDraftStore.getState();
    expect(state.answersByRequestKey[key]).toEqual({
      q1: { selectedOptionValues: ["Switching chats"] },
    });
    expect(state.questionIndexByRequestKey[key]).toBe(1);
  });

  it("skips the update when nothing changed", () => {
    const before = usePendingUserInputDraftStore.getState();
    before.setAnswersByRequestKey((existing) => existing);
    expect(usePendingUserInputDraftStore.getState()).toBe(before);
  });

  it("drops a card's draft once it is answered or dismissed", () => {
    const state = usePendingUserInputDraftStore.getState();
    const other = JSON.stringify(["env", "thread-a", "request-2"]);
    state.setAnswersByRequestKey({
      [key]: { q1: { customAnswer: "done" } },
      [other]: { q1: { customAnswer: "still open" } },
    });
    state.setQuestionIndexByRequestKey({ [key]: 2 });
    state.clearRequest(key);
    const after = usePendingUserInputDraftStore.getState();
    expect(after.answersByRequestKey).toEqual({ [other]: { q1: { customAnswer: "still open" } } });
    expect(after.questionIndexByRequestKey).toEqual({});
    after.clearRequest(key);
    expect(usePendingUserInputDraftStore.getState()).toBe(after);
  });
});

it.each(["answered elsewhere", "timed out", "turn ended", "cancelled"])(
  "keeps current composer text and normal attachments when the request is %s",
  () => {
    const target = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread-a"),
    };
    const composer = useComposerDraftStore.getState();
    const file = {
      type: "file" as const,
      id: "normal-file",
      name: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: new File(["note"], "note.txt"),
    };
    composer.setPrompt(target, "Text typed before the question");
    composer.addFiles(target, [file], { appendReference: false });
    setPendingUserInputComposerAnswer(
      target,
      key,
      { id: "q1", multiSelect: false },
      "Text typed before the question and after",
    );
    expect(
      usePendingUserInputDraftStore.getState().answersByRequestKey[key]?.q1?.customAnswer,
    ).toBe("Text typed before the question and after");
    usePendingUserInputDraftStore.getState().clearRequest(key);
    expect(composer.getComposerDraft(target)?.prompt).toBe(
      "Text typed before the question and after",
    );
    expect(composer.getComposerDraft(target)?.files).toEqual([file]);
  },
);
