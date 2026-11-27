import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  BOT_COLOR_KEYS,
  BOT_PERMISSION_ROWS,
  BOT_PERSONALITY_PLACEHOLDER,
  CREATE_BOT_LABEL,
  NEW_BOT_LABEL,
  botPalette,
  cleanBotName,
  nextBotColor,
  nextBotName,
} from "@t3tools/client-runtime/state/bots";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  BOT_NAME_MAX,
  BOT_PERSONALITY_MAX,
  DEFAULT_BOT_PERMISSIONS,
  EnvironmentId,
  type BotPermissions,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ListSection } from "../../components/ListSection";
import { ListToggleRow } from "../../components/ListToggleRow";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { BotAvatar } from "./BotAvatar";
import { BotModelRow } from "./BotModelRow";
import { BotSheetFrame } from "./BotSheetFrame";
import { isBotThreadKey, type BotEntry } from "./botVisibility";
import { botThreadKeysAtom, useBotEntries, useBotEntry, useBotsEnabled } from "./state";
import { useBotMutation } from "./useBotActions";

type BotEditorParams = { readonly environmentId?: string; readonly botId?: string } | undefined;

/** The user's most recent chat (not a bot's, not a subagent's): where a new bot lives and its model. */
function mostRecentChat(machines: ReadonlyArray<EnvironmentId>) {
  const botKeys = appAtomRegistry.get(botThreadKeysAtom);
  let latest: { environmentId: EnvironmentId; modelSelection: ModelSelection } | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const chat of appAtomRegistry.get(environmentThreadShells.threadShellsAtom)) {
    if (!machines.includes(chat.environmentId)) continue;
    if (chat.lineage.relationshipToParent === "subagent") continue;
    if (isBotThreadKey(botKeys, { environmentId: chat.environmentId, threadId: chat.id })) continue;
    const at = getThreadSortTimestamp(chat, "updated_at");
    if (at > latestAt) {
      latestAt = at;
      latest = { environmentId: chat.environmentId, modelSelection: chat.modelSelection };
    }
  }
  return latest;
}

/**
 * New bot and Edit bot: a live avatar with the eight colors, a name, the app's model picker,
 * an optional personality and the four permissions in plain words. Creating one makes its
 * home chat on the machine of the user's latest chat and opens it.
 */
export function BotEditorSheet({ route }: StaticScreenProps<BotEditorParams>) {
  const editing = useBotEntry(route.params?.environmentId, route.params?.botId);
  const { targets } = useBotsEnabled();
  // Fixed when the sheet opens: later chats must not move the bot or its default model.
  const [recent] = useState(() => mostRecentChat(targets));
  const environmentId = editing?.environmentId ?? recent?.environmentId ?? targets[0] ?? null;
  if (route.params?.botId && editing === null)
    return (
      <BotSheetFrame title="Bot">
        <Text className="px-6 pt-6 text-base text-foreground-muted">
          This bot is gone or Bots are off.
        </Text>
      </BotSheetFrame>
    );
  if (environmentId === null)
    return (
      <BotSheetFrame title={NEW_BOT_LABEL}>
        <Text className="px-6 pt-6 text-base text-foreground-muted">
          Connect a machine running SSHCode to make a bot.
        </Text>
      </BotSheetFrame>
    );
  return <BotEditorForm editing={editing} environmentId={environmentId} recent={recent} />;
}

function BotEditorForm(props: {
  readonly editing: BotEntry | null;
  readonly environmentId: EnvironmentId;
  readonly recent: ReturnType<typeof mostRecentChat>;
}) {
  const { editing, environmentId, recent } = props;
  const navigation = useNavigation();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const allBots = useBotEntries();
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);

  const [name, setName] = useState(
    () => editing?.bot.name ?? nextBotName(allBots.map((entry) => entry.bot)),
  );
  const [color, setColor] = useState<string>(
    () => editing?.bot.color ?? nextBotColor(allBots.map((entry) => entry.bot)),
  );
  const [personality, setPersonality] = useState(() => editing?.bot.personality ?? "");
  const [permissions, setPermissions] = useState<BotPermissions>(
    () => editing?.bot.permissions ?? DEFAULT_BOT_PERMISSIONS,
  );
  const [chosen, setChosen] = useState<ModelSelection | null>(() => editing?.bot.target ?? null);
  const [busy, setBusy] = useState(false);
  const run = useBotMutation();

  const fallbackModel = useMemo(() => {
    if (recent?.environmentId === environmentId) return recent.modelSelection;
    return config?.settings.defaultModelSelection ?? null;
  }, [config, environmentId, recent]);
  const selection = chosen ?? fallbackModel;
  const pickModel = useCallback((next: ModelSelection) => setChosen(next), []);

  const cleanName = cleanBotName(name);
  const canSave = cleanName.length > 0 && selection !== null && !busy && config !== undefined;
  const save = async () => {
    if (!canSave || selection === null) return;
    setBusy(true);
    const trimmedPersonality = personality.trim().slice(0, BOT_PERSONALITY_MAX);
    const result = editing
      ? await run(
          environmentId,
          {
            type: "update",
            botId: editing.bot.id,
            name: cleanName,
            color,
            target: selection,
            personality: trimmedPersonality,
            permissions,
          },
          `Could not save ${cleanName}`,
        )
      : await run(
          environmentId,
          {
            type: "create",
            name: cleanName,
            color,
            target: selection,
            ...(trimmedPersonality.length > 0 ? { personality: trimmedPersonality } : {}),
            permissions,
          },
          `Could not create ${cleanName}`,
        );
    setBusy(false);
    if (result === null) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const created = editing ? null : result.bot;
    if (created) {
      // Straight into the new bot's chat, on its hello.
      selectThread({ environmentId, id: created.threadId });
      return;
    }
    navigation.goBack();
  };

  return (
    <BotSheetFrame
      title={editing ? `Edit ${editing.bot.name}` : NEW_BOT_LABEL}
      action={{
        label: busy ? "Saving…" : editing ? "Save" : CREATE_BOT_LABEL,
        onPress: () => void save(),
        disabled: !canSave,
      }}
    >
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-4 pt-2 pb-8"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center gap-4 pt-2">
          <BotAvatar color={color} size={84} seed={editing?.bot.id ?? "new"} />
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Color"
            className="flex-row flex-wrap justify-center gap-2.5"
          >
            {BOT_COLOR_KEYS.map((key) => {
              const selected = key === color;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="radio"
                  accessibilityLabel={key}
                  accessibilityState={{ selected }}
                  hitSlop={4}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setColor(key);
                  }}
                  className="size-9 items-center justify-center rounded-full border-2 active:opacity-70"
                  style={{ borderColor: selected ? botPalette(key).fill : "transparent" }}
                >
                  <View
                    className="size-7 rounded-full"
                    style={{ backgroundColor: botPalette(key).fill }}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
        <ListSection title="Name">
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={BOT_NAME_MAX}
            editable={!busy}
            autoCapitalize="words"
            autoCorrect={false}
            accessibilityLabel="Bot name"
            className="px-4 text-base"
          />
        </ListSection>
        <ListSection title="Model">
          <BotModelRow
            ownerId={`bot-editor:${environmentId}:${editing?.bot.id ?? "new"}`}
            environmentId={environmentId}
            selection={selection}
            onChange={pickModel}
            disabled={busy}
          />
        </ListSection>
        <ListSection title="Personality">
          <TextInput
            multiline
            value={personality}
            onChangeText={setPersonality}
            maxLength={BOT_PERSONALITY_MAX}
            editable={!busy}
            placeholder={BOT_PERSONALITY_PLACEHOLDER}
            accessibilityLabel="Personality"
            className="max-h-40 min-h-20 px-4 py-3 text-base"
            style={{ textAlignVertical: "top" }}
          />
        </ListSection>
        <ListSection title="Permissions" separated>
          {BOT_PERMISSION_ROWS.map((row) => (
            <ListToggleRow
              key={row.key}
              label={row.title}
              description={row.copy}
              value={permissions[row.key]}
              disabled={busy}
              onValueChange={(value) => {
                void Haptics.selectionAsync();
                setPermissions((current) => ({ ...current, [row.key]: value }));
              }}
            />
          ))}
        </ListSection>
      </ScrollView>
    </BotSheetFrame>
  );
}
