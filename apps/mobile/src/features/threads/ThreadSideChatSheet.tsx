import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { shouldRetryThreadOutboxDelivery } from "../../state/thread-outbox-model";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type SideChatActivity,
  type SideChatKind,
  type SideChatMessage,
  type SideChatState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
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

import {
  HarnessThemeScope,
  useAppearancePreferences,
} from "../settings/appearance/AppearancePreferencesProvider";
import { useHarnessProseStyle } from "../settings/appearance/useHarnessProseStyle";
import { resolveMobileHarnessDriver } from "../../lib/harnessThemes";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { uuidv4 } from "../../lib/uuid";
import { sideChatPromptAbout, splitSideChatQuote } from "@t3tools/shared/sideChatQuote";
import { useThreadSideChat } from "./useThreadSideChat";
import {
  acknowledgedSideChatsAtom,
  pendingSends,
  pendingSendMetadata,
} from "../../state/pending-sends";
import { appAtomRegistry } from "../../state/atom-registry";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  sideChatAcceptsInput,
  sideChatEnded,
  sideChatErrorMessage,
  sideChatSubtitle,
  sideChatTitle,
} from "./sideChatPresentation";

type ThreadSideChatParams = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly kind: SideChatKind;
  /** The question typed after `/btw` or `/side`; absent when opened from the header. */
  readonly prompt?: string;
  /** Reply text selected in the chat; the next question is asked about it. */
  readonly quote?: string;
  readonly messageId?: string;
};

/**
 * The harness's own side conversation (Claude Code `/btw`, Codex `/side`) as
 * a sheet over the thread. Dismissing it leaves the server answering; the
 * exchange also appears in the chat and is restored when this sheet reopens.
 */
export function ThreadSideChatSheet(props: StaticScreenProps<ThreadSideChatParams>) {
  const { selectedThread } = useThreadSelection();
  const runtime = useRemoteEnvironmentRuntime(EnvironmentId.make(props.route.params.environmentId));
  const thread =
    selectedThread?.environmentId === props.route.params.environmentId &&
    selectedThread.id === props.route.params.threadId
      ? selectedThread
      : null;
  const driver = resolveMobileHarnessDriver({
    thread,
    providers: runtime?.serverConfig?.providers ?? [],
    providerInstances: runtime?.serverConfig?.settings.providerInstances,
  });
  return (
    <HarnessThemeScope driver={driver}>
      <ThreadSideChatContent {...props} />
    </HarnessThemeScope>
  );
}

function ThreadSideChatContent({ route }: StaticScreenProps<ThreadSideChatParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const initialPrompt = route.params.prompt?.trim() ?? "";
  const queuedSends = useAtomValue(pendingSends.awaitingAckAtom);
  const queued = queuedSends.find(
    (send) =>
      send.kind === "side-question" &&
      send.environmentId === environmentId &&
      send.threadId === threadId,
  );
  const acceptedStates = useAtomValue(acknowledgedSideChatsAtom);
  const openedState = acceptedStates[scopedThreadKey(environmentId, threadId)] ?? null;
  const activeAttemptRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [quote, setQuote] = useState(() => route.params.quote?.trim() || null);
  const [submitting, setSubmitting] = useState(false);
  const [initialMessageId] = useState(() => route.params.messageId ?? uuidv4());
  const startedInitialPromptRef = useRef(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Like the Claude app, a new question is followed only until it reaches the top,
  // so a long answer reads from its start. Dragging stops that until the next question.
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

  const subscription = useThreadSideChat(environmentId, threadId);
  const subscriptionState = Option.getOrElse(AsyncResult.value(subscription), () => null);
  const openedQuestionId = openedState?.messages.findLast((message) => message.role === "user")?.id;
  const openingAcknowledged =
    openedState !== null &&
    subscriptionState?.sideChatId === openedState.sideChatId &&
    subscriptionState.messages.some((message) => message.id === openedQuestionId);
  // An RPC response can beat the subscription's next snapshot, including its
  // initial null. Keep that accepted question until the stream catches up.
  const liveState = openedState !== null && !openingAcknowledged ? openedState : subscriptionState;
  useEffect(() => {
    if (!openingAcknowledged) return;
    const key = scopedThreadKey(environmentId, threadId);
    const current = appAtomRegistry.get(acknowledgedSideChatsAtom);
    if (current[key] !== openedState) return;
    const next = { ...current };
    delete next[key];
    appAtomRegistry.set(acknowledgedSideChatsAtom, next);
  }, [environmentId, openedState, openingAcknowledged, threadId]);
  // Like Claude Code's /btw, a side chat that had already closed when the sheet
  // opened isn't shown again: the next question starts a fresh one.
  const [firstState, setFirstState] = useState<SideChatState | null | undefined>(undefined);
  if (firstState === undefined && liveState !== null) setFirstState(liveState);
  const hiddenSideChatId = firstState?.status === "closed" ? firstState.sideChatId : null;
  const state = liveState?.sideChatId === hiddenSideChatId ? null : liveState;
  const subscriptionError =
    subscription._tag === "Failure" &&
    !shouldRetryThreadOutboxDelivery(Cause.squash(subscription.cause))
      ? sideChatErrorMessage(Cause.squash(subscription.cause))
      : null;
  const kind = state?.kind ?? route.params.kind;
  const visiblePending =
    queued?.kind === "side-question" && !state?.messages.some((message) => message.id === queued.id)
      ? queued
      : null;
  useEffect(() => {
    if (queued && state?.messages.some((message) => message.id === queued.id)) {
      pendingSends.acknowledge(queued);
    }
  }, [queued, state]);
  const ended = sideChatEnded(state);
  const answering = state?.status === "starting" || state?.status === "running";
  const canSend =
    draft.trim().length > 0 &&
    !submitting &&
    queued === undefined &&
    (ended || sideChatAcceptsInput(state));

  const start = useCallback(
    async (prompt: string, messageId?: string, typed = prompt) => {
      if (activeAttemptRef.current) return;
      activeAttemptRef.current = true;
      followRef.current.following = true;
      setError(null);
      setSubmitting(true);
      try {
        await pendingSends.enqueue({
          ...pendingSendMetadata(),
          ...(messageId ? { id: CommandId.make(messageId) } : {}),
          kind: "side-question",
          environmentId,
          threadId,
          prompt,
        });
        setDraft((current) => (current.trim() === typed ? "" : current));
        if (typed !== prompt) setQuote(null);
      } catch {
        setDraft((current) => (current.trim().length > 0 ? current : typed));
        setError("Could not save the question. Your text is still here. Try again.");
      } finally {
        activeAttemptRef.current = false;
        setSubmitting(false);
      }
    },
    [environmentId, threadId],
  );

  useEffect(() => {
    if (initialPrompt.length === 0 || startedInitialPromptRef.current) return;
    startedInitialPromptRef.current = true;
    void start(initialPrompt, initialMessageId);
  }, [initialMessageId, initialPrompt, start]);

  const send = async () => {
    const question = draft.trim();
    if (!canSend) return;
    void Haptics.selectionAsync();
    await start(sideChatPromptAbout(quote, question), undefined, question);
  };

  const messages = state?.messages ?? [];
  const lastMessage = messages.at(-1);
  const lastQuestionId =
    visiblePending === null ? messages.findLast((message) => message.role === "user")?.id : null;
  const showsWorking =
    (answering || visiblePending !== null) &&
    !(lastMessage?.role === "assistant" && lastMessage.status === "streaming") &&
    !ended;
  const shownError = error ?? queued?.error ?? subscriptionError ?? state?.error ?? null;
  const retryQuestion =
    state?.messages.at(-1)?.status === "failed"
      ? state.messages.findLast((message) => message.role === "user")?.text
      : undefined;
  const placeholder = answering
    ? "Waiting for the answer…"
    : ended
      ? "Ask again to start a new one"
      : quote !== null
        ? "Ask about the selection"
        : kind === "btw"
          ? "Ask a side question"
          : "Message the side chat";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View
          className="flex-row items-start gap-3 px-5 pb-2"
          style={{ paddingTop: Platform.OS === "android" ? insets.top + 12 : 18 }}
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-lg font-t3-bold text-foreground">{sideChatTitle(kind)}</Text>
            <Text className="text-xs leading-normal text-foreground-muted">
              {sideChatSubtitle(kind)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${sideChatTitle(kind)}`}
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
          {messages.map((message) =>
            message.role === "user" ? (
              <SideChatUserBubble
                key={message.id}
                text={message.text}
                onLayout={message.id === lastQuestionId ? measureQuestion : undefined}
              />
            ) : (
              <SideChatAssistantMessage key={message.id} message={message} />
            ),
          )}
          {visiblePending ? (
            <SideChatUserBubble text={visiblePending.prompt} onLayout={measureQuestion} />
          ) : null}
          {visiblePending && !queued?.error ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              Waiting for network…
            </Text>
          ) : showsWorking ? (
            <WorkingLine />
          ) : null}
          {shownError ? (
            <View className="rounded-2xl border border-danger-border bg-card px-3.5 py-2.5">
              <Text className="text-sm leading-normal text-danger-foreground">{shownError}</Text>
              {queued?.error ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry side question"
                  className="min-h-11 justify-center active:opacity-60"
                  onPress={() => void pendingSends.retry(queued)}
                >
                  <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
                </Pressable>
              ) : retryQuestion && !answering ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry side question"
                  className="min-h-11 justify-center active:opacity-60"
                  onPress={() => void start(retryQuestion, uuidv4())}
                >
                  <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </ScrollView>

        {quote !== null ? (
          <View className="mx-4 mt-2 flex-row items-start gap-2 rounded-xl border-s-2 border-border bg-subtle py-1.5 ps-2.5 pe-1">
            <SymbolView
              name="text.quote"
              size={12}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
              style={{ marginTop: 3 }}
            />
            <Text numberOfLines={3} className="min-w-0 flex-1 text-sm text-foreground-muted">
              {quote}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove the selected text"
              hitSlop={8}
              onPress={() => setQuote(null)}
              className="h-6 w-6 items-center justify-center active:opacity-60"
            >
              <SymbolView
                name="xmark"
                size={11}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </Pressable>
          </View>
        ) : null}
        <View
          className="flex-row items-end gap-2 border-t border-border-subtle px-4 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <TextInput
            autoFocus={initialPrompt.length === 0}
            multiline
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholder}
            accessibilityLabel={placeholder}
            className="max-h-32 min-h-11 flex-1 rounded-[22px] py-2.5"
          />
          <View className="pb-1">
            <ControlPill
              accessibilityLabel="Send"
              icon="arrow.up"
              variant="primary"
              disabled={!canSend}
              onPress={() => void send()}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function SideChatUserBubble(props: {
  readonly text: string;
  readonly onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
}) {
  const { harnessThemePreset } = useAppearancePreferences();
  const bubble = harnessThemePreset?.view.userBubble;
  // A question about selected reply text shows that text quietly above it.
  const quoted = splitSideChatQuote(props.text);
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
      {quoted.quote !== null ? (
        <Text
          numberOfLines={3}
          className="mb-1 border-s-2 border-user-bubble-foreground/30 ps-2 text-sm text-user-bubble-foreground-muted"
        >
          {quoted.quote}
        </Text>
      ) : null}
      <Text selectable className="text-base leading-normal text-user-bubble-foreground">
        {quoted.question}
      </Text>
    </View>
  );
}

function SideChatAssistantMessage(props: { readonly message: SideChatMessage }) {
  const styles = useMarkdownPreviewStyles();
  const proseStyle = useHarnessProseStyle();
  const openLink = useOpenPullRequest();
  const { message } = props;
  return (
    <View className="gap-2">
      {message.activities.length > 0 ? (
        <View className="gap-1">
          {message.activities.map((activity) => (
            <ActivityLine key={activity.id} activity={activity} />
          ))}
        </View>
      ) : null}
      {message.text.trim().length > 0 ? (
        <SelectableMarkdownText
          markdown={message.text}
          plainValues
          textStyle={{ ...styles.nativeTextStyle, ...proseStyle }}
          onLinkPress={(href) => void openLink(href)}
        />
      ) : null}
      {message.status === "streaming" ? <WorkingLine /> : null}
      {message.status === "failed" ? (
        <Text className="text-xs text-danger-foreground">This answer did not finish.</Text>
      ) : null}
    </View>
  );
}

function ActivityLine(props: { readonly activity: SideChatActivity }) {
  const { activity } = props;
  return (
    <View className="flex-row items-center gap-1.5">
      <View className="h-4 w-4 items-center justify-center">
        {activity.status === "running" ? (
          <AppActivityIndicator
            size="small"
            colorClassName="accent-icon-muted"
            style={{ transform: [{ scale: 0.7 }] }}
          />
        ) : (
          <SymbolView
            name={activity.status === "failed" ? "xmark" : "checkmark"}
            size={10}
            tintColorClassName={
              activity.status === "failed" ? "accent-danger-foreground" : "accent-icon-muted"
            }
            type="monochrome"
          />
        )}
      </View>
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {activity.label.replaceAll("`", "")}
      </Text>
    </View>
  );
}

function WorkingLine() {
  return (
    <View accessible accessibilityLabel="Working" className="flex-row items-center gap-2">
      <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
      <Text className="text-sm text-foreground-muted">Working…</Text>
    </View>
  );
}
