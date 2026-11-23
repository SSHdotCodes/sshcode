// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ListState } from "./list-state";

it("replaces pending content with the empty result and its next step", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(<ListState loading title="Loading archived threads…" />));
    expect(host.textContent).toContain("Loading archived threads…");
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-busy")).toBe("true");
    await act(async () =>
      root.render(
        <ListState
          title="No archived threads"
          description="Threads you archive will appear here."
        />,
      ),
    );
    expect(host.textContent).not.toContain("Loading");
    expect(host.textContent).toContain("No archived threads");
    expect(host.textContent).toContain("Threads you archive will appear here.");
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
