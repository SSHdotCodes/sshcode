import { useNavigation } from "@react-navigation/native";
import { OVERVIEW_SUGGESTIONS, type OverviewEntry } from "@t3tools/client-runtime/overview";
import type { EnvironmentId } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type ScrollViewInstance,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { HarnessMascot } from "../../components/HarnessMascot";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  HarnessThemeScope,
  useAppearancePreferences,
} from "../settings/appearance/AppearancePreferencesProvider";
import { useHarnessProseStyle } from "../settings/appearance/useHarnessProseStyle";
import { useOverview, useOverviewEnvironmentId } from "./useOverview";

/** Overview runs on Claude, so it wears Clawd and the Claude look. */
const OVERVIEW_DRIVER = "claudeAgent";

export function OverviewSheet() {
  const environmentId = useOverviewEnvironmentId();
  return (
    <HarnessThemeScope driver={OVERVIEW_DRIVER}>
      <OverviewContent environmentId={environmentId} />
    </HarnessThemeScope>
  );
}

function OverviewContent({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const openLink = useOpenPullRequest();
  const { entries, working, error, send } = useOverview(environmentId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Like the side chat: follow a new question until it reaches the top, so a
  // long answer reads from its start. Dragging stops that until the next one.
  const followRef = useRef({ following: true, y: 0, question: 0, content: 0, viewport: 0 });
  const follow = () => {
    const scroll = followRef.current;
    if (!scroll.following) return;
    const y = Math.min(
      Math.max(0, scroll.content - scroll.viewport),
      Math.max(0, scroll.question - 8),
    );
    if (y > scroll.y + 1) scrollRef.current?.scrollTo({ y, animated: true });
  };
  const measureQuestion = (event: LayoutChangeEvent) => {
    followRef.current.question = event.nativeEvent.layout.y;
    follow();
  };

  const ask = (text: string) => {
    if (text.trim().length === 0 || environmentId === null) return;
    void Haptics.selectionAsync();
    followRef.current.following = true;
    setDraft("");
    void send(text);
  };
  const onLinkPress = (href: string) => {
    const linkedThreadId = parseThreadLinkHref(href);
    if (linkedThreadId && environmentId !== null) {
      navigation.goBack();
      navigation.navigate("Thread", {
        environmentId: String(environmentId),
        threadId: String(linkedThreadId),
      });
      return;
    }
    void openLink(href);
  };

  const last = entries.at(-1);
  const lastQuestionId = entries.findLast((entry) => entry.role === "user")?.id;
  const looking = working && !(last?.role === "assistant" && last.streaming);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View
          className="flex-row items-center gap-3 px-5 pb-2"
          style={{ paddingTop: Platform.OS === "android" ? insets.top + 12 : 18 }}
        >
          <HarnessMascot driver={OVERVIEW_DRIVER} size={28} still />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-lg font-t3-bold text-foreground">Overview</Text>
            <Text className="text-xs leading-normal text-foreground-muted">
              What your chats are up to · Prototype
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close Overview"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            className="h-8 w-8 items-center justify-center rounded-full bg-subtle active:opacity-60"
          >
            <SymbolView name="xmark" size={13} tintColorClassName="accent-icon" type="monochrome" />
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pb-4 pt-2"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={(event) => {
            followRef.current.y = event.nativeEvent.contentOffset.y;
          }}
          onScrollBeginDrag={() => {
            followRef.current.following = false;
          }}
          onLayout={(event) => {
            followRef.current.viewport = event.nativeEvent.layout.height;
            follow();
          }}
          onContentSizeChange={(_width, height) => {
            followRef.current.content = height;
            follow();
          }}
        >
          {entries.length === 0 ? (
            <View className="items-center gap-3 pt-8">
              <HarnessMascot driver={OVERVIEW_DRIVER} state="greet" size={64} />
              <Text className="text-lg font-t3-bold text-foreground">
                What would you like to know?
              </Text>
              <Text className="max-w-[300px] text-center text-sm leading-normal text-foreground-muted">
                I can see all your chats and tell you what's going on. I only look; I never change
                anything.
              </Text>
              <View className="mt-1 flex-row flex-wrap justify-center gap-2">
                {OVERVIEW_SUGGESTIONS.map((suggestion) => (
                  <Pressable
                    key={suggestion}
                    accessibilityRole="button"
                    disabled={environmentId === null}
                    onPress={() => ask(suggestion)}
                    className="rounded-full border border-border bg-card px-3.5 py-2 active:opacity-60"
                  >
                    <Text className="text-sm text-foreground">{suggestion}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            entries.map((entry) =>
              entry.role === "user" ? (
                <OverviewQuestion
                  key={entry.id}
                  text={entry.text}
                  onLinkPress={onLinkPress}
                  onLayout={entry.id === lastQuestionId ? measureQuestion : undefined}
                />
              ) : (
                <OverviewAnswer key={entry.id} entry={entry} onLinkPress={onLinkPress} />
              ),
            )
          )}
          {looking ? (
            <View accessible accessibilityLabel="Looking" className="flex-row items-center gap-2">
              <HarnessMascot driver={OVERVIEW_DRIVER} state="working" size={22} />
              <Text className="text-sm text-foreground-muted">Looking…</Text>
            </View>
          ) : null}
          {error ? (
            <View className="rounded-2xl border border-danger-border bg-card px-3.5 py-2.5">
              <Text className="text-sm leading-normal text-danger-foreground">{error}</Text>
            </View>
          ) : null}
          {environmentId === null ? (
            <Text className="text-sm text-foreground-muted">
              Connect to your Mac to see what your chats are doing.
            </Text>
          ) : null}
        </ScrollView>

        <View
          className="flex-row items-end gap-2 border-t border-border-subtle px-4 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <TextInput
            multiline
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask about your chats"
            accessibilityLabel="Ask about your chats"
            className="max-h-32 min-h-11 flex-1 rounded-[22px] py-2.5"
          />
          <View className="pb-1">
            <ControlPill
              accessibilityLabel="Send"
              icon="arrow.up"
              variant="primary"
              disabled={draft.trim().length === 0 || environmentId === null}
              onPress={() => ask(draft)}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function OverviewQuestion(props: {
  readonly text: string;
  readonly onLinkPress: (href: string) => void;
  readonly onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
}) {
  const { harnessThemePreset } = useAppearancePreferences();
  const bubble = harnessThemePreset?.view.userBubble;
  const styles = useMarkdownPreviewStyles("user");
  return (
    <View
      onLayout={props.onLayout}
      className="max-w-[85%] self-end rounded-[20px] bg-user-bubble px-3.5 py-2"
      style={
        bubble
          ? {
              borderRadius: bubble.radius,
              paddingHorizontal: bubble.paddingX,
              paddingVertical: bubble.paddingY,
            }
          : undefined
      }
    >
      <SelectableMarkdownText
        markdown={props.text}
        textStyle={styles.nativeTextStyle}
        preserveSoftBreaks
        onLinkPress={props.onLinkPress}
      />
    </View>
  );
}

function OverviewAnswer(props: {
  readonly entry: OverviewEntry;
  readonly onLinkPress: (href: string) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const proseStyle = useHarnessProseStyle();
  return (
    <SelectableMarkdownText
      markdown={props.entry.text}
      plainValues
      textStyle={{ ...styles.nativeTextStyle, ...proseStyle }}
      onLinkPress={props.onLinkPress}
    />
  );
}
