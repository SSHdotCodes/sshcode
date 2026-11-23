// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AnchoredToastProvider, ToastProvider } from "./toast";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));

it("exposes one Notifications landmark and keeps anchored toasts live", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    await act(() =>
      root.render(
        <ToastProvider>
          <AnchoredToastProvider>{null}</AnchoredToastProvider>
        </ToastProvider>,
      ),
    );
    expect(document.querySelectorAll('[role="region"][aria-label="Notifications"]')).toHaveLength(
      1,
    );
    expect(
      document.querySelector('[data-slot="toast-viewport-anchored"]')?.getAttribute("aria-live"),
    ).toBe("polite");
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
