// @vitest-environment jsdom
import { act, startTransition, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useCommittedRef } from "./useCommittedRef";
import { useThreadVisitWatermark } from "./useThreadVisitWatermark";

it("keeps actions and the unread boundary on the visible chat during a suspended switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const sent: string[] = [];
  const visits: string[] = [];
  const pending = new Promise<never>(() => {});
  let suspended = false;
  function Chat({ thread, visited }: { thread: string; visited: string }) {
    const target = useCommittedRef(thread);
    const { visitWatermark, lastDispatchedVisitRef } = useThreadVisitWatermark(thread, visited);
    if (thread === "B") {
      suspended = true;
      throw pending;
    }
    return (
      <button
        onClick={() => {
          sent.push(target.current);
          if (lastDispatchedVisitRef.current !== thread) visits.push(thread);
          lastDispatchedVisitRef.current = thread;
        }}
      >
        {visitWatermark?.lastVisitedAt}
      </button>
    );
  }
  const view = (thread: string, visited: string) => (
    <Suspense fallback={null}>
      <Chat thread={thread} visited={visited} />
    </Suspense>
  );
  try {
    await act(() => root.render(view("A", "first visit")));
    host.querySelector("button")!.click();
    await act(() => startTransition(() => root.render(view("B", "other visit"))));
    expect(suspended).toBe(true);
    host.querySelector("button")!.click();
    await act(() => root.render(view("A", "server acknowledgement")));
    expect.soft(sent).toEqual(["A", "A"]);
    expect.soft(visits).toEqual(["A"]);
    expect(host.textContent).toBe("first visit");
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
