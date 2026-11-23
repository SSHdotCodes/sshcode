import { useLayoutEffect, useRef } from "react";

/** Current value for callbacks that can run while a replacement view is rendering. */
export function useCommittedRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
