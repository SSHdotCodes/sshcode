// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId, type CasualVoiceDisplay } from "@t3tools/contracts";
import {
  casualVoiceActive,
  parseCasualDecisions,
  segmentCasualMessage,
} from "@t3tools/shared/casualVoice";
import { CasualAssistantSurface } from "./CasualAssistantSurface";

const gate = vi.hoisted(() => ({
  calls: [] as string[],
  display: null as CasualVoiceDisplay | null,
  command: async (value: { input: { action: string } }) => {
    gate.calls.push(value.input.action);
    const backend = { kind: "local" as const, url: "http://127.0.0.1:9/v1/", model: "fake" };
    return {
      _tag: "Success" as const,
      value: {
        enabled: true,
        backend,
        models: [],
        ...(value.input.action === "rewrite" && gate.display ? { display: gate.display } : {}),
      },
    };
  },
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return { ...actual, useAtomValue: () => true };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => gate.command,
}));

const original = "The answer is ready.\nHope this helps.";
let root: Root;
let host: HTMLDivElement;
let thread = 0;

function surface(active: boolean) {
  thread += 1;
  return (
    <CasualAssistantSurface
      active={active}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make(`thread-${thread}`)}
      messageId={MessageId.make("message")}
      original={original}
      streaming={false}
      runId={null}
      role="final"
      agent="agent"
      revealOriginal={false}
      renderOriginal={(text) => <p>{text}</p>}
      renderBubble={(text) => <p>{text}</p>}
    />
  );
}

async function flush() {
  for (let step = 0; step < 8; step += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    onchange: null,
  }));
  gate.calls = [];
  gate.display = parseCasualDecisions(
    segmentCasualMessage(original, "final"),
    "1 say: the answer is ready\n+ say: here is the next bit\n2 hide: filler",
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("makes no casual-voice requests in either layout while the setting is off", async () => {
  expect(casualVoiceActive(false)).toBe(false);
  await act(async () => root.render(surface(casualVoiceActive(false))));
  await flush();
  expect(gate.calls).toEqual([]);
  expect(host.querySelector("[data-casual-bubble]")).toBeNull();
  expect(host.textContent).toContain("The answer is ready.");
  expect(host.textContent).not.toContain("show original");
});

it("renders rewritten bubbles and show original when the setting is on", async () => {
  expect(casualVoiceActive(true)).toBe(true);
  await act(async () => root.render(surface(casualVoiceActive(true))));
  await flush();
  expect(gate.calls).toContain("get");
  expect(gate.calls).toContain("rewrite");
  expect(host.querySelector("[data-casual-bubble]")).not.toBeNull();
  expect(host.textContent).toContain("the answer is ready");
  expect(host.textContent).toContain("show original");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[data-casual-voice-actions] button")!.click(),
  );
  expect(host.textContent).toContain("The answer is ready.");
  expect(host.textContent).toContain("show casual");
});

it("renders the original message in Discord mode while the setting is off", async () => {
  await act(async () => root.render(surface(false)));
  await flush();
  expect(gate.calls).toEqual([]);
  expect(host.textContent).toContain("The answer is ready.");
  expect(host.textContent).not.toContain("the answer is ready");
  expect(host.querySelector("[data-casual-voice-actions]")).toBeNull();
});
