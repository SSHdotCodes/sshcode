// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ThreadRowStatusText } from "./ThreadRowStatusText";

vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

function visibleText(props: { status?: string; preview?: string; error?: string }) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(() => root.render(<ThreadRowStatusText className="" {...props} />));
    return host.textContent;
  } finally {
    act(() => root.unmount());
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

it.each([
  ["Needs you", "Which build should I use?"],
  ["Needs you", "Approve running the tests"],
  ["Waiting on 3 monitors", "The release is queued"],
  ["Reconnecting", "Captured your changes"],
  ["Failed", "Last completed step"],
  ["Limited", "Last completed step"],
  ["Working 2m", "Running tests"],
])("shows the preview beside %s", (status, preview) => {
  expect(visibleText({ status, preview })).toBe(`${status} · ${preview}`);
});

it.each(["Failed", "Limited"])("shows the error on a %s row ahead of an older reply", (status) => {
  expect(visibleText({ status, error: "Provider unavailable", preview: "Earlier reply" })).toBe(
    `${status} · Provider unavailable`,
  );
});

it("shows a status on its own when there is no additional context", () => {
  expect(visibleText({ status: "Offline" })).toBe("Offline");
  expect(visibleText({ status: "Offline", preview: "Offline" })).toBe("Offline");
});
