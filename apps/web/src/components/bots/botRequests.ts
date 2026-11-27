import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Requests to open the bot dialogs, kept apart from the dialogs so menus and the palette can
 * open them without loading them. `BotDialogsHost` renders whichever is asked for.
 */
export type BotSheetRequest = {
  readonly environmentId: EnvironmentId;
  readonly botId: string | null;
};
export const useBotSheetRequest = create<{ request: BotSheetRequest | null }>(() => ({
  request: null,
}));

/** Opens New bot, or Edit for `botId`. One sheet serves Settings, the sidebar and the info panel. */
export function openBotSheet(environmentId: EnvironmentId, botId: string | null = null) {
  useBotSheetRequest.setState({ request: { environmentId, botId } });
}

export const closeBotSheet = () => useBotSheetRequest.setState({ request: null });

export type SendToBotRequest = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly botId: string;
};
export const useSendToBotRequest = create<{ request: SendToBotRequest | null }>(() => ({
  request: null,
}));

/** "Send to <bot>…" from a chat's menu or the palette: the chat's link plus an optional note. */
export function openSendToBot(environmentId: EnvironmentId, threadId: ThreadId, botId: string) {
  useSendToBotRequest.setState({ request: { environmentId, threadId, botId } });
}

export const closeSendToBot = () => useSendToBotRequest.setState({ request: null });
