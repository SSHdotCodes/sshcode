import { createContext } from "react";

// Kept apart from HarnessMascot so the lazily loaded sprite can read these without an import cycle.
export const HarnessMascotTurnDuration = createContext(0);
export const HarnessMascotDriver = createContext<string | null>(null);
export const HarnessMascotAgentId = createContext<string | null>(null);
