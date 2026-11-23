// @vitest-environment jsdom
import { RuntimeRequestId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

let root: Root;
let container: HTMLDivElement;
const respond = vi.fn(async () => undefined);
async function render(canRespond: boolean) {
  await act(async () =>
    root.render(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval")}
        canRespond={canRespond}
        isResponding={false}
        onRespondToApproval={respond}
      />,
    ),
  );
}
function more() {
  return container.querySelector<HTMLButtonElement>('[aria-label="More approval options"]')!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  respond.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("does not offer secondary decisions when the provider cannot receive them", async () => {
  await render(false);
  await act(async () => more().click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
});

it("stops secondary decisions in an already open menu when the provider goes away", async () => {
  await render(true);
  await act(async () => more().click());
  const allow = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Always allow this session",
  )!;
  expect(allow).toBeDefined();
  await render(false);
  await act(async () => allow.click());
  expect(respond).not.toHaveBeenCalled();
});
