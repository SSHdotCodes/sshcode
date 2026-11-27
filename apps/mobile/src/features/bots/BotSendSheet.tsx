import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sendToBotLabel } from "@t3tools/client-runtime/state/bots";
import { BOT_SEND_NOTE_MAX, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ScrollView } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ListSection } from "../../components/ListSection";
import { useThreadShell } from "../../state/entities";
import { BotAvatar } from "./BotAvatar";
import { BotSheetFrame } from "./BotSheetFrame";
import { useBotEntry } from "./state";
import { useBotMutation } from "./useBotActions";

type BotSendParams = {
  readonly environmentId: string;
  readonly botId: string;
  readonly threadId: string;
};

/** "Send to <bot>…": hands the bot a link to this chat and an optional note. */
export function BotSendSheet({ route }: StaticScreenProps<BotSendParams>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const entry = useBotEntry(environmentId, route.params.botId);
  const chat = useThreadShell(scopeThreadRef(environmentId, threadId));
  const run = useBotMutation();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  if (entry === null) {
    return (
      <BotSheetFrame title="Send to bot">
        <Text className="px-6 pt-6 text-base text-foreground-muted">
          This bot is gone or Bots are off.
        </Text>
      </BotSheetFrame>
    );
  }
  const { bot } = entry;
  const send = async () => {
    if (sending) return;
    setSending(true);
    const trimmed = note.trim();
    const result = await run(
      environmentId,
      {
        type: "send",
        botId: bot.id,
        threadId,
        ...(trimmed.length > 0 ? { note: trimmed.slice(0, BOT_SEND_NOTE_MAX) } : {}),
      },
      `Could not send to ${bot.name}`,
    );
    setSending(false);
    if (result === null) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    navigation.goBack();
  };

  return (
    <BotSheetFrame
      title={sendToBotLabel(bot.name).replace(/…$/u, "")}
      action={{
        label: sending ? "Sending…" : "Send",
        onPress: () => void send(),
        disabled: sending,
      }}
    >
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-4 pt-2 pb-6"
        keyboardShouldPersistTaps="handled"
      >
        <ListSection>
          <ListRowLayout
            leading={<BotAvatar color={bot.color} size={28} seed={bot.id} still />}
            label={chat?.title ?? "This chat"}
            description={`${bot.name} gets a link to this chat.`}
          />
        </ListSection>
        <ListSection>
          <TextInput
            multiline
            autoFocus
            value={note}
            editable={!sending}
            maxLength={BOT_SEND_NOTE_MAX}
            onChangeText={setNote}
            placeholder="Add a note (optional)"
            accessibilityLabel={`Note for ${bot.name}`}
            className="max-h-48 min-h-24 px-4 py-3 text-base"
            style={{ textAlignVertical: "top" }}
          />
        </ListSection>
      </ScrollView>
    </BotSheetFrame>
  );
}
