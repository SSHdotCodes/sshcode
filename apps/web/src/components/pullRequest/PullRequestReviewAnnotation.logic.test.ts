import { describe, expect, it, vi } from "@effect/vitest";

import { submitKeys } from "./PullRequestReviewAnnotation";

function keyboardEvent(input: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
}) {
  const event = {
    key: input.key,
    ctrlKey: input.ctrlKey ?? false,
    metaKey: input.metaKey ?? false,
    keyCode: input.keyCode ?? 0,
    nativeEvent: { isComposing: input.isComposing ?? false },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  return event as unknown as React.KeyboardEvent<HTMLTextAreaElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

describe("submitKeys", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }] as const)(
    "leaves IME keys to the composition without cancelling or submitting",
    (composing) => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const handler = submitKeys({ value: "Draft", pending: false, onSubmit, onCancel });

      for (const key of ["Escape", "Enter"] as const) {
        const event = keyboardEvent({ key, ctrlKey: key === "Enter", ...composing });
        handler(event);
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    },
  );

  it("still cancels on Escape and submits on Mod+Enter outside composition", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const handler = submitKeys({ value: "Draft", pending: false, onSubmit, onCancel });

    const escape = keyboardEvent({ key: "Escape" });
    handler(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();

    const enter = keyboardEvent({ key: "Enter", ctrlKey: true });
    handler(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
