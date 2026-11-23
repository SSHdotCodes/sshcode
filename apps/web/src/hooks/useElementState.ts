import { useState } from "react";

/**
 * The element a callback ref is attached to, as state. A hidden <Activity>
 * detaches refs but keeps its DOM, so the element stays while it is still in
 * the document: a kept chat view re-renders neither when hidden nor when shown.
 * It clears once the element has left the document.
 */
export function useElementState<T extends Element>() {
  const [element, setElement] = useState<T | null>(null);
  const [ref] = useState(() => {
    let attached: T | null = null;
    return (next: T | null) => {
      if (next !== null) {
        attached = next;
        setElement(next);
        return;
      }
      const detached = attached;
      attached = null;
      if (detached === null) return;
      // React detaches refs before it removes the DOM; check after the commit.
      queueMicrotask(() => {
        if (attached !== null || detached.isConnected) return;
        setElement((current) => (current === detached ? null : current));
      });
    };
  });
  return [element, ref] as const;
}
