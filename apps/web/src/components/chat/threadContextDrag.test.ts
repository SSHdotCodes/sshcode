import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, createElement, memo, useRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropKind,
  threadContextDropTargetProps,
  useThreadContextDrop,
} from "./threadContextDrag";

describe("useThreadContextDrop", () => {
  it("delivers a drop to the thread a memoized composer shows now", () => {
    const target = new EventTarget();
    const droppedInto: string[] = [];
    // The real composer is memo()-wrapped; it reuses one instance across thread switches.
    const Composer = memo(function Composer({ threadKey }: { threadKey: string }) {
      const targetRef = useRef<EventTarget | null>(target);
      useThreadContextDrop(targetRef, EnvironmentId.make("environment"), threadKey, () => {
        droppedInto.push(threadKey);
      });
      return null;
    });
    const drop = () =>
      target.dispatchEvent(
        new CustomEvent<ReadonlyArray<ScopedThreadRef>>(THREAD_CONTEXT_DROP_EVENT, { detail: [] }),
      );

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = create(createElement(Composer, { threadKey: "first" }));
      });
      act(drop);
      act(() => renderer?.update(createElement(Composer, { threadKey: "second" })));
      act(drop);
      expect(droppedInto).toEqual(["first", "second"]);
    } finally {
      act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("labels composer drops as mentions and pane drops as split view", () => {
    expect(threadContextDropTargetProps()).toEqual({
      "data-thread-context-drop": "composer",
      "data-thread-context-drop-label": "Mention",
    });
    expect(threadContextDropTargetProps("split")).toMatchObject({
      "data-thread-context-drop": "split",
      "data-thread-context-drop-label": "Open in split view",
    });
    expect(threadContextDropKind(null)).toBeNull();
    const pane = { getAttribute: () => "split" } as unknown as EventTarget;
    expect(threadContextDropKind(pane)).toBe("split");
  });
});
