import { useNavigation } from "@react-navigation/native";
import { deleteBotConfirm } from "@t3tools/client-runtime/state/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotOperation, BotOperationResult, EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useAtomCommand } from "../../state/use-atom-command";
import type { BotEntry } from "./botVisibility";
import { mutateBots } from "./state";

/** "Delete Pip? Its chat…" as a dialog title and message. */
function splitConfirm(text: string): { readonly title: string; readonly message: string } {
  const end = text.indexOf("? ");
  return end < 0
    ? { title: text, message: "" }
    : { title: text.slice(0, end + 1), message: text.slice(end + 2) };
}

/** Runs one `bots.mutate` operation; failures show as an alert, not a silent no-op. */
export function useBotMutation() {
  const mutate = useAtomCommand(mutateBots, { label: "bots mutate", reportFailure: false });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      operation: BotOperation,
      failureTitle: string,
    ): Promise<BotOperationResult | null> => {
      const result = await mutate({ environmentId, input: operation });
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        Alert.alert(
          failureTitle,
          cause instanceof Error && cause.message.length > 0 ? cause.message : "Try again.",
        );
      }
      return null;
    },
    [mutate],
  );
}

/** Edit, pause or resume, and delete (after a confirm), shared by every place a bot shows. */
export function useBotActions() {
  const navigation = useNavigation();
  const run = useBotMutation();
  const edit = useCallback(
    (entry: BotEntry) =>
      navigation.navigate("BotEditor", {
        environmentId: String(entry.environmentId),
        botId: entry.bot.id,
      }),
    [navigation],
  );
  const setPaused = useCallback(
    (entry: BotEntry, paused: boolean) => {
      void Haptics.selectionAsync();
      void run(
        entry.environmentId,
        { type: "pause", botId: entry.bot.id, paused },
        paused ? `Could not pause ${entry.bot.name}` : `Could not resume ${entry.bot.name}`,
      );
    },
    [run],
  );
  const remove = useCallback(
    (entry: BotEntry, onDeleted?: () => void) => {
      const { title, message } = splitConfirm(deleteBotConfirm(entry.bot.name));
      showConfirmDialog({
        title,
        message,
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          void run(
            entry.environmentId,
            { type: "delete", botId: entry.bot.id },
            `Could not delete ${entry.bot.name}`,
          ).then((result) => {
            if (result === null) return;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onDeleted?.();
          });
        },
      });
    },
    [run],
  );
  return { edit, setPaused, remove };
}
