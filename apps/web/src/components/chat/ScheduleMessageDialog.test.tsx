// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ScheduleMessageDialog } from "./ScheduleMessageDialog";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("submits the date field through its form and blocks duplicate submissions", async () => {
  let finish: (() => void) | undefined;
  const schedule = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  await act(async () =>
    root.render(
      <ScheduleMessageDialog
        prompt="Review this"
        disabledReason={null}
        onClose={close}
        onSchedule={schedule}
      />,
    ),
  );
  const input = document.querySelector<HTMLInputElement>("#schedule-message-time")!;
  const form = input.form;
  expect(form).not.toBeNull();
  const submit = [...form!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Schedule message"),
  )!;
  expect(submit.type).toBe("submit");
  act(() => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(schedule).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish!());
  expect(close).toHaveBeenCalledOnce();
});
