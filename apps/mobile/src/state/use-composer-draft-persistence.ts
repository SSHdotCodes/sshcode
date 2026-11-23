import { useEffect } from "react";
import { AppState } from "react-native";

import { flushComposerDrafts } from "./use-composer-drafts";

/** Land the last keystrokes before iOS can suspend the editor's runtime. */
export function useComposerDraftPersistence(draftKey: string | null | undefined): void {
  useEffect(() => {
    if (!draftKey) return;
    const flush = () => {
      void flushComposerDrafts().catch((error: unknown) => {
        console.warn("[composer-drafts] could not flush the current draft", error);
      });
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [draftKey]);
}
