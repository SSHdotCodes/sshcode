import { createContext } from "react";

/** The viewer keeps the composer destination it was opened from, including queued edits. */
export const ImageMarkupDraftKey = createContext<string | null>(null);
