// @vitest-environment jsdom
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";

const state = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { setReaction: {} } }));

import { PullRequestReactionBar } from "./PullRequestReactions";

it("keeps the latest reaction choice when an older toggle fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.send.mockReset();
  let failFirst = () => {};
  let finishLater = () => {};
  state.send
    .mockReturnValueOnce(new Promise((resolve) => (failFirst = () => resolve({ _tag: "Failure" }))))
    .mockReturnValue(
      new Promise(
        (resolve) => (finishLater = () => resolve({ _tag: "Success", value: undefined })),
      ),
    );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <PullRequestReactionBar
          environmentId={EnvironmentId.make("test")}
          reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
          reactions={[
            { content: "thumbs-up", count: 1, viewerHasReacted: false, actors: ["other"] },
          ]}
          canReact={true}
          onRefresh={() => {}}
        />,
      ),
    );
    const pill = () => container.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    for (let i = 0; i < 3; i++) await act(() => pill().click());
    expect(state.send).toHaveBeenCalledTimes(3);
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    await act(() => failFirst());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    await act(() => finishLater());
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
