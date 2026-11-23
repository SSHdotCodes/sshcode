// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

vi.mock("../HarnessMascot", () => ({ HarnessMascot: () => null }));
vi.mock("../MascotCompanion", () => ({ MascotCompanion: () => null }));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => "mac",
    scratchWorkspaceRootFor: () => "/home/fake",
  }),
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => "mac" }));

it("shows the new-chat headline without a CLI continuation link", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <DraftHeroHeadline draftId={null} activeProjectRef={null} activeProjectTitle={null} />,
    ),
  );
  expect(container.querySelector("h1")?.textContent).toBe("What should we work on?");
  expect(container.textContent).not.toContain("Continue a CLI session");
  expect(container.querySelector("button, a")).toBeNull();
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
