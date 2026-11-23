import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/** Chats as a grid of session boxes, or the classic title rows. This device only. */
export type SidebarLayout = "boxes" | "list";

// v2: the classic rows are the default again; boxes are opt-in from Settings.
const SIDEBAR_LAYOUT_KEY = "t3code:sidebar-layout:v2";
const SidebarLayoutSchema = Schema.Literals(["boxes", "list"]);

export function useSidebarLayout() {
  return useLocalStorage<SidebarLayout, SidebarLayout>(
    SIDEBAR_LAYOUT_KEY,
    "list",
    SidebarLayoutSchema,
  );
}
