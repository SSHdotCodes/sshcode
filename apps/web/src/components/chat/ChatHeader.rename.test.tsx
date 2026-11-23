// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const updateMetadata = vi.hoisted(() => vi.fn());

vi.mock("~/hooks/usePrivacyMode", () => ({
  usePrivacyLabel: () => (_kind: string, _id: string, label: string) => label,
  usePrivacyMode: () => false,
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => updateMetadata,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironment: () => null,
}));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useThreadShell: () => null,
}));
vi.mock("../../hooks/useTheme", () => ({ useUiMode: () => ["default"] }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, () => {}] }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => undefined }));
vi.mock("../discord/DiscordMemberList", () => ({ DiscordMemberList: () => null }));
vi.mock("../discord/CasualVoiceControl", () => ({ CasualVoiceControl: () => null }));
vi.mock("../computer-use/ComputerUseStatus", () => ({ ComputerUseStatus: () => null }));
vi.mock("../workflows/WorkflowRunCrumb", () => ({ WorkflowRunCrumb: () => null }));

import { ChatHeader } from "./ChatHeader";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("chat");
let root: Root;
let host: HTMLDivElement;

const render = (title: string) =>
  act(() =>
    root.render(
      <ChatHeader
        activeThreadEnvironmentId={environmentId}
        activeThreadId={threadId}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        sideChatControlShown={false}
        onNewThreadInProject={() => {}}
      />,
    ),
  );
const titleField = () => host.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
const startRename = () =>
  act(() =>
    host
      .querySelector('button[aria-haspopup="menu"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
const press = (key: string) =>
  act(() => titleField()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  updateMetadata.mockReset();
  updateMetadata.mockResolvedValue({ _tag: "Success" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("renames to the title an earlier, abandoned rename started from", () => {
  render("Old");
  startRename();
  expect(titleField()?.defaultValue).toBe("Old");
  // The title changes underneath the open field (a generated title), then the rename is dropped.
  render("Generated");
  press("Escape");
  expect(titleField()).toBeNull();

  // A second rename starts from "Generated". Typing the earlier title is a real change.
  startRename();
  expect(titleField()?.defaultValue).toBe("Generated");
  titleField()!.value = "Old";
  press("Enter");

  expect(updateMetadata).toHaveBeenCalledTimes(1);
  expect(updateMetadata).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, title: "Old" },
  });
});
