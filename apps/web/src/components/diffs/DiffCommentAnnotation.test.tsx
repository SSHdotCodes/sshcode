// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

const callbacks = {
  onTextChange: vi.fn(),
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

describe("DiffCommentAnnotation", () => {
  it("renders the shared draft composer directly in the selected diff", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation kind="draft" rangeLabel="+78" text="" {...callbacks} />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("Local comment");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("⌘/Ctrl Enter to send");
    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Comment</button>");
    expect(markup).toContain("autofocus");
    // The comment box is the standard small Textarea, not a bespoke surface.
    expect(markup).toMatch(/<span[^>]*data-size="sm"[^>]*data-slot="textarea-control"/);
  });

  it("lets a pull-request diff configure actions without replacing the composer", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="src/app.ts:4"
        text=""
        {...callbacks}
        submitLabel="Add to review"
        secondaryAction={{
          label: "Add to agent",
          onAction: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Add to review</button>");
    expect(markup.match(/<button[^>]*disabled[^>]*>Add to review<\/button>/)).not.toBeNull();
    expect(markup.match(/<button[^>]*disabled[^>]*>Add to agent<\/button>/)).not.toBeNull();
  });

  it("renders a saved comment without a nested card or redundant range label", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Please keep this branch explicit."
        {...callbacks}
      />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("Please keep this branch explicit.");
    expect(markup).toContain('aria-label="Delete comment"');
    expect(markup).toContain("border-s-2");
    expect(markup).toContain("bg-primary/[0.045]");
    expect(markup).toContain("lucide-message-circle");
  });

  it("renders draft text owned by the annotation wrapper", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text="Keep this unsaved draft"
        {...callbacks}
      />,
    );

    expect(markup).toContain("Keep this unsaved draft");
  });
});

it("keeps Escape and send shortcuts in the IME until composition ends", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onCancel = vi.fn();
  const onComment = vi.fn();
  const onOuterKey = vi.fn();
  document.body.addEventListener("keydown", onOuterKey);

  try {
    await act(() =>
      root.render(
        <DiffCommentAnnotation
          kind="draft"
          rangeLabel="3"
          text="Draft"
          onTextChange={() => undefined}
          onCancel={onCancel}
          onComment={onComment}
          focusOnMount={false}
        />,
      ),
    );
    const textarea = container.querySelector("textarea")!;
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const shortcut of [{ key: "Escape" }, { key: "Enter", metaKey: true }]) {
        const event = new KeyboardEvent("keydown", {
          ...composition,
          ...shortcut,
          bubbles: true,
          cancelable: true,
        });
        await act(() => {
          textarea.dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(onCancel).not.toHaveBeenCalled();
    expect(onComment).not.toHaveBeenCalled();
    expect(onOuterKey).not.toHaveBeenCalled();

    await act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComment).toHaveBeenCalledExactlyOnceWith("Draft");
  } finally {
    await act(() => root.unmount());
    document.body.removeEventListener("keydown", onOuterKey);
    container.remove();
    vi.unstubAllGlobals();
  }
});
