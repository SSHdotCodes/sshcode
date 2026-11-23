import { createContext } from "react";

export interface MessageMenuAction {
  readonly text: string;
  readonly icon?: string;
  /** Also shown as a button under the message, not only in its menu. */
  readonly inline?: boolean;
  readonly onPress: () => void;
}

export const MessageMenuContext = createContext<ReadonlyArray<MessageMenuAction>>([]);
