// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
const announce = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AccessibilityInfo: { announceForAccessibility: announce },
}));
import { useAnnounceRequest } from "./use-announce-request";

it("announces each request once without reannouncing response or text updates", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  function Probe({ id, message }: { id: string; message: string }) {
    useAnnounceRequest(id, message);
    return null;
  }
  try {
    act(() => root.render(<Probe id="approval-1" message="Approval needed" />));
    act(() => root.render(<Probe id="approval-1" message="Sending response" />));
    act(() => root.render(<Probe id="question-2" message="Question from the agent" />));
    act(() => root.render(<Probe id="approval-1" message="Approval updated" />));
    expect(announce.mock.calls).toEqual([["Approval needed"], ["Question from the agent"]]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
