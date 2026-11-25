// @vitest-environment jsdom

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ThreadChipPreview } from "./ThreadChipPreview";
import { Tooltip, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const { readPrivacy, readProject, providersValueAtom } = vi.hoisted(() => ({
  readPrivacy: vi.fn(),
  readProject: vi.fn(),
  providersValueAtom: vi.fn(),
}));

vi.mock("~/hooks/usePrivacyMode", () => ({ usePrivacyMode: readPrivacy }));
vi.mock("~/state/entities", () => ({ useProject: readProject }));
vi.mock("~/state/server", () => ({ serverEnvironment: { providersValueAtom } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [
    {
      instanceId: "fixture",
      driver: "codex",
      displayName: "Fixture account",
      models: [{ slug: "qa-balanced", name: "QA Balanced" }],
    },
  ],
}));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./ThreadStatusIndicators", () => ({ ThreadPullRequestsMiniList: () => null }));

const shell = {
  id: ThreadId.make("thread"),
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  branch: "preview-branch",
  runtime: null,
  modelSelection: { instanceId: ProviderInstanceId.make("fixture"), model: "qa-balanced" },
  pullRequests: [],
  source: { latestVisibleMessage: { role: "assistant", text: "Changed the hover card." } },
} satisfies NonNullable<ComponentProps<typeof ThreadChipPreview>["shell"]>;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  readProject.mockReturnValue({ title: "Preview project" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "reads preview metadata only on hover with privacy off (privacy: %s)",
  async (privacy) => {
    readPrivacy.mockReturnValue(privacy);
    await act(async () =>
      root.render(
        <TooltipProvider delay={100}>
          <Tooltip>
            <TooltipTrigger render={<button type="button">Linked chat</button>} />
            <ThreadChipPreview shell={shell} title="Fixture chat title" />
          </Tooltip>
        </TooltipProvider>,
      ),
    );
    expect(readProject).not.toHaveBeenCalled();
    expect(providersValueAtom).not.toHaveBeenCalled();

    const trigger = container.querySelector("button")!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(110);
    });

    const popup = document.querySelector('[data-slot="tooltip-popup"][data-open]');
    expect(popup).not.toBeNull();
    if (privacy) {
      expect(popup?.textContent).toContain("Details hidden");
      expect(popup?.textContent).not.toContain("Fixture chat title");
      expect(readProject).not.toHaveBeenCalled();
      expect(providersValueAtom).not.toHaveBeenCalled();
    } else {
      expect(popup?.textContent).toContain("Fixture chat title");
      expect(popup?.textContent).toContain("Preview project");
      expect(popup?.textContent).toContain("preview-branch");
      expect(popup?.textContent).toContain("QA Balanced");
      expect(popup?.textContent).toContain("Changed the hover card.");
      expect(readProject).toHaveBeenCalledWith({ environmentId: "remote", projectId: "project" });
      expect(providersValueAtom).toHaveBeenCalledWith("remote");
    }
  },
);
