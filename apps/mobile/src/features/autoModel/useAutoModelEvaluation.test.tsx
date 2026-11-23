// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { AutoModelCandidate } from "@t3tools/shared/autoModel/recommendAutoModel";
import type { ModelPicks } from "@t3tools/shared/modelPicks";
import { RegistryContext } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Answer =
  | { _tag: "Success"; value: { quick: number; model: string } | null }
  | { _tag: "Failure" };
const harness = vi.hoisted(() => ({
  classified: 0,
  decisions: [] as Array<number | undefined>,
  asked: [] as Array<unknown>,
  answer: (): Promise<Answer> => Promise.resolve({ _tag: "Success", value: null }),
}));
// The real modules load React Native; the hook only needs the command's result.
vi.mock("../../state/server", () => ({ serverEnvironment: { decideAutoModelTask: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => (request: unknown) => {
    harness.asked.push(request);
    return harness.answer();
  },
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make<unknown[]>([]) } };
});
vi.mock("../../state/use-model-option-memory", () => ({
  withRememberedModelOptions: <T,>(selection: T) => selection,
}));
vi.mock("@t3tools/shared/autoModel/classifyTaskDifficulty", () => ({
  classifyTaskDifficulty: (input: { decisionQuick?: number }) => {
    harness.classified++;
    harness.decisions.push(input.decisionQuick);
    return input.decisionQuick !== undefined && input.decisionQuick < 0.25
      ? { tier: "big", confidence: 0.9 }
      : { tier: "fast", confidence: 0.9 };
  },
}));

const { appAtomRegistry } = await import("../../state/atom-registry");
const { environmentThreadShells } = await import("../../state/threads");
// The mock's atom is writable; the real one is derived.
const chatList = environmentThreadShells.threadShellsAtom as unknown as Atom.Writable<never>;
const updateOtherChats = () => appAtomRegistry.set(chatList, [] as never);
const { useAutoModelDraft } = await import("./autoModelDraftState");
const { AUTO_MODEL_DEBOUNCE_MS, useAutoModelEvaluation } = await import("./useAutoModelEvaluation");

const environmentId = EnvironmentId.make("local");
const power = { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5-2" };
const quick = { instanceId: "claude", model: "claude-haiku-5-5" };
const makeCandidates = (): AutoModelCandidate[] => [
  { selection: power, label: "Fable 5.2", quality: 100, available: true },
  { selection: quick, label: "Haiku 5.5", quality: 40, available: true },
];
const route = (selection: typeof quick) => ({ winner: { route: selection } });
const makePicks = () =>
  ({
    candidates: [],
    picks: { quality: route(power), speed: route(quick), frugal: route(quick) },
  }) as unknown as ModelPicks;

let renders = 0;
function Composer(props: { readonly draftKey: string; readonly text: string }) {
  renders++;
  const state = useAutoModelDraft(props.draftKey);
  const candidates = makeCandidates();
  const picks = makePicks();
  // New identities every render, as the screen's provider refreshes produce.
  useAutoModelEvaluation({
    draftKey: props.draftKey,
    enabled: true,
    text: props.text,
    attachmentCount: 0,
    selectionKey: "claude:claude-fable-5-2",
    evidenceKey: "2|quality|speed",
    latest: { environmentId, currentSelection: power, candidates, picks },
  });
  return <span>{state.recommendation?.label ?? ""}</span>;
}

function App(props: { readonly draftKey: string; readonly text: string }) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <Composer {...props} />
    </RegistryContext.Provider>
  );
}

let root: Root;
let container: HTMLDivElement;
let draftKey = 0;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  renders = 0;
  harness.classified = 0;
  harness.decisions = [];
  harness.asked = [];
  harness.answer = () => Promise.resolve({ _tag: "Success", value: null });
  draftKey++;
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const PROMPT = "Rename the helper in utils to something clearer";

/** Lets the server's answer, a resolved promise, reach the hook. */
const settle = () => act(async () => {});

it("suggests once typing pauses, without other chats pushing the timer back", async () => {
  const key = `draft-${draftKey}`;
  act(() => root.render(<App draftKey={key} text={PROMPT} />));
  // Other chats keep updating and the composer redraws with fresh arrays meanwhile.
  for (let step = 0; step < 3; step++) {
    act(() => {
      updateOtherChats();
      root.render(<App draftKey={key} text={PROMPT} />);
    });
    act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS / 4));
  }
  expect(harness.classified).toBe(0);
  act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS / 4));
  await settle();
  expect(harness.classified).toBe(1);
  expect(container.textContent).toBe("Haiku 5.5");
});

it("costs one render per keystroke, plus one when the suggestion arrives", async () => {
  const key = `draft-${draftKey}`;
  const keystrokes = PROMPT.length;
  for (let length = 1; length <= keystrokes; length++) {
    act(() => root.render(<App draftKey={key} text={PROMPT.slice(0, length)} />));
    act(() => vi.advanceTimersByTime(50));
  }
  // Busy chats elsewhere do not redraw the composer: the history is read when the timer fires.
  act(() => {
    for (let update = 0; update < 20; update++) {
      updateOtherChats();
    }
  });
  expect(renders).toBe(keystrokes);
  act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS));
  await settle();
  expect(harness.classified).toBe(1);
  expect(renders).toBe(keystrokes + 1);

  // The same result again (a new model list, same evidence) writes nothing and redraws nothing.
  act(() => root.render(<App draftKey={key} text={`${PROMPT} `} />));
  act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS));
  await settle();
  expect(harness.classified).toBe(2);
  expect(renders).toBe(keystrokes + 2);
});

it("asks the server's decision model and lets a hard verdict withdraw the quick model", async () => {
  // A later time than any earlier "no answer", so the server is asked again.
  vi.setSystemTime(Date.now() + 10 * 60_000);
  harness.answer = () =>
    Promise.resolve({ _tag: "Success", value: { quick: 0.02, model: "decider" } });
  const key = `draft-${draftKey}`;
  act(() => root.render(<App draftKey={key} text={`  ${PROMPT}  `} />));
  act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS));
  expect(harness.asked).toEqual([{ environmentId, input: { text: PROMPT, attachmentCount: 0 } }]);
  expect(harness.classified).toBe(0);
  await settle();
  expect(harness.decisions).toEqual([0.02]);
  // Hard, and already on the strong model: the quick model is no longer offered.
  expect(container.textContent).toBe("");
});

it("decides alone when the server does not answer, and leaves it alone for a minute", async () => {
  vi.setSystemTime(Date.now() + 20 * 60_000);
  harness.answer = () => Promise.resolve({ _tag: "Failure" });
  const key = `draft-${draftKey}`;
  act(() => root.render(<App draftKey={key} text={PROMPT} />));
  act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS));
  await settle();
  expect(harness.decisions).toEqual([undefined]);
  expect(container.textContent).toBe("Haiku 5.5");
  act(() => root.render(<App draftKey={key} text={`${PROMPT} now`} />));
  act(() => vi.advanceTimersByTime(AUTO_MODEL_DEBOUNCE_MS));
  expect(harness.asked).toHaveLength(1);
  expect(harness.classified).toBe(2);
});
