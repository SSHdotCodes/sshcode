// @vitest-environment jsdom
import type { EnvironmentId, XPostPreview } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { getXPostPreview: "read" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.read }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../localApi", () => ({ readLocalApi: () => undefined }));

import { XPostEmbeds } from "./XPostEmbeds";

const environmentId = "env" as EnvironmentId;
const card = (id: string, patch: Partial<XPostPreview> = {}): XPostPreview => ({
  url: `https://x.com/someone/status/${id}`,
  authorName: "Some One",
  authorHandle: "someone",
  text: `post ${id}`,
  createdAt: "2026-11-09T12:00:00.000Z",
  image: null,
  ...patch,
});
const success = (value: XPostPreview | null) => ({ _tag: "Success", value });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.read.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const draw = (text: string) =>
  act(async () => {
    root.render(<XPostEmbeds text={text} environmentId={environmentId} />);
  });

it("draws a small card per linked post and looks each post up once", async () => {
  state.read.mockImplementation(async ({ input }: { input: { url: string } }) =>
    success(
      input.url.endsWith("/9001")
        ? card("9001", {
            image: { url: "https://pbs.twimg.com/media/a.jpg?name=small", video: true },
          })
        : card("9002"),
    ),
  );
  await draw(
    "look https://x.com/someone/status/9001?s=46 and https://twitter.com/someone/status/9002 and https://x.com/someone/status/9001",
  );
  const cards = [...host.querySelectorAll<HTMLAnchorElement>("[data-x-post-card]")];
  expect(cards.map((entry) => entry.dataset.xPostCard)).toEqual(["9001", "9002"]);
  expect(cards[0]!.href).toBe("https://x.com/someone/status/9001");
  expect(cards[0]!.textContent).toContain("Some One");
  expect(cards[0]!.textContent).toContain("@someone");
  expect(cards[0]!.textContent).toContain("post 9001");
  expect(cards[0]!.querySelector("img")?.getAttribute("src")).toBe(
    "https://pbs.twimg.com/media/a.jpg?name=small",
  );
  expect(cards[1]!.querySelector("img")).toBeNull();
  expect(state.read).toHaveBeenCalledTimes(2);

  // Drawn again (a chat scrolled back into view): from memory, no new lookup.
  act(() => root.unmount());
  root = createRoot(host);
  await draw("again https://x.com/someone/status/9001");
  expect(host.querySelectorAll("[data-x-post-card]")).toHaveLength(1);
  expect(state.read).toHaveBeenCalledTimes(2);
});

it("draws nothing for a post X will not show, and tries again after a failed call", async () => {
  state.read.mockResolvedValueOnce(success(null));
  await draw("https://x.com/someone/status/9003");
  expect(host.querySelector("[data-x-post-card]")).toBeNull();

  state.read.mockResolvedValueOnce({ _tag: "Failure" });
  await draw("https://x.com/someone/status/9004");
  expect(host.querySelector("[data-x-post-card]")).toBeNull();
  state.read.mockResolvedValueOnce(success(card("9004")));
  act(() => root.unmount());
  root = createRoot(host);
  await draw("https://x.com/someone/status/9004");
  expect(host.querySelector("[data-x-post-card]")).not.toBeNull();
});

it("asks for nothing when a message has no post links", async () => {
  await draw("plain text with https://x.com/someone and `https://x.com/a/status/1`");
  expect(host.innerHTML).toBe("");
  expect(state.read).not.toHaveBeenCalled();
});
