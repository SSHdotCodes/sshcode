import { useUiMode } from "../discord/useUiMode";
import { useAnnounceRequest } from "./use-announce-request";
import {
  HarnessMascot,
  HarnessMascotAgentId,
  HarnessMascotDriver,
  useHarnessMascotReady,
} from "../../components/HarnessMascot";
import { RequestActionButton } from "./RequestActionButton";
import { QuestionAttachments } from "./QuestionAttachments";
import type { RuntimeRequestId } from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { harnessMascotForDriver } from "@t3tools/shared/harnessMascots";
import { use, useCallback, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  KeyboardAwareScrollView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeInUp,
  FadeOutDown,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import {
  derivePendingUserInputMaxHeight,
  questionScrollMaxHeight,
  USER_INPUT_TOGGLE_DURATION_MS,
} from "./pendingUserInputLayout";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  isPendingUserInputOptionSelected,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  readonly heightConstraints: Omit<
    Parameters<typeof derivePendingUserInputMaxHeight>[0],
    "keyboardHeight"
  >;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** Renders a stop control on the collapsed bar and the expanded card, which replace the composer. */
  readonly onStopThread?: () => void;
  /**
   * 0 collapsed → 1 expanded. Slides the iOS overlay card down behind the
   * collapsed bar (inside a clipping window) on the UI thread; the host
   * animates it directly from the tap handler so the card and the feed
   * inset glide start the same frame.
   */
  readonly cardProgress?: SharedValue<number>;
  /**
   * Receives how far the expanded card extends above the bar footprint
   * (written from onLayout with no re-render); the host adds it to the
   * thread feed's end inset so the end of the chat stays visible above the
   * card.
   */
  readonly cardCoverage?: SharedValue<number>;
  /** Fires on custom-answer focus/blur; hosts use it to vet stale keyboard state. */
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly deliveryStatus?: string | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  /** Closes an async question without a reply. Hidden for native callback questions. */
  readonly onDismiss: () => Promise<unknown>;
}

/**
 * On iOS the collapsed bar is the PERMANENT in-flow footprint — the expanded
 * card is an absolutely-positioned overlay rising above it. The overlay's
 * measured height (which drives the thread feed's bottom inset) therefore
 * never changes on collapse/expand, so the transcript stays perfectly still
 * while the card animates over it.
 *
 * Android cannot use the overlay: it does not hit-test touches outside a
 * parent's bounds, which made everything above the bar-sized wrapper
 * untouchable. There the expanded card renders in-flow instead (the wrapper
 * grows with it, and the host skips the coverage inset since the measured
 * overlay already includes the card).
 */
const EXPANDED_CARD_IS_OVERLAY = Platform.OS === "ios";

const CARD_LAYOUT_TRANSITION = LinearTransition.duration(200);

/** Renders question text as markdown so agent-provided links open on tap. */
function QuestionText(props: { readonly markdown: string }) {
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  return (
    <SelectableMarkdownText
      markdown={props.markdown}
      textStyle={styles.nativeTextStyle}
      onLinkPress={(href) => void openLink(href)}
    />
  );
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const mascotDriver = use(HarnessMascotDriver);
  const mascotAgentId = use(HarnessMascotAgentId);
  const mascot = harnessMascotForDriver(mascotDriver, mascotAgentId);
  const mascotReady = useHarnessMascotReady(mascot?.id ?? null);
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const [footerHeight, setFooterHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const { heightConstraints } = props;
  const maxHeight = derivePendingUserInputMaxHeight({ ...heightConstraints, keyboardHeight: 0 });
  // Resize on the same UI-thread keyboard clock as the sticky host's translation.
  // Reserving an estimated keyboard at rest can hide every answer on phones with a tab bar.
  const keyboardHeightStyle = useAnimatedStyle(() => ({
    maxHeight: derivePendingUserInputMaxHeight({
      ...heightConstraints,
      keyboardHeight: -keyboardHeight.value,
    }),
  }));
  // The card's max height clips; the question list needs its own max height so
  // the custom answer scrolls above the keyboard instead of disappearing under it.
  const scrollMaxHeight = useAnimatedStyle(() => ({
    maxHeight: questionScrollMaxHeight({
      cardMaxHeight: derivePendingUserInputMaxHeight({
        ...heightConstraints,
        keyboardHeight: -keyboardHeight.value,
      }),
      headerHeight,
      footerHeight,
    }),
  }));
  const questionCount = props.pendingUserInput.questions.length;
  // Message responses start a new run and remain available after the provider exits.
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;
  const sendDisabled = !props.canOperateThread || responseDisabled || props.answers === null;
  // Async questions (`ask_user`, Codex's) are answered by message while the
  // agent keeps working, so they read as a question rather than a blocker.
  const asks = props.pendingUserInput.responseMode === "message";
  const eyebrow = asks ? "Question from the agent" : "User input needed";
  useAnnounceRequest(
    props.pendingUserInput.requestId,
    `${eyebrow}. ${questionCount} ${questionCount === 1 ? "question" : "questions"}.`,
  );

  const cardCoverage = props.cardCoverage;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  // Measured card height, written straight from onLayout: the collapse slide
  // distance. Not animated — it only changes on discrete relayouts.
  const cardHeight = useSharedValue(0);
  const notifyCoverage = useCallback(() => {
    if (!cardCoverage) {
      return;
    }
    const coverage = Math.max(0, cardHeightRef.current - barHeightRef.current);
    if (coverage === cardCoverage.value) {
      return;
    }
    if (cardCoverage.value === 0) {
      // First measurement lands while the list is doing its initial
      // end-pin (thread opened onto a pending request); animating it from
      // zero would move the end anchor out from under that scroll.
      cardCoverage.value = coverage;
      return;
    }
    // Animated so a coverage change at rest (discrete max-height
    // corrections) glides the feed instead of stepping it; toggle timing is
    // owned by the host's progress values.
    cardCoverage.value = withTiming(coverage, {
      duration: USER_INPUT_TOGGLE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [cardCoverage]);
  const handleBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
      barHeightRef.current = event.nativeEvent.layout.height;
      notifyCoverage();
    },
    [notifyCoverage],
  );
  const handleCardLayout = useCallback(
    (event: LayoutChangeEvent) => {
      cardHeightRef.current = event.nativeEvent.layout.height;
      cardHeight.value = event.nativeEvent.layout.height;
      notifyCoverage();
    },
    [cardHeight, notifyCoverage],
  );
  const cardProgress = props.cardProgress;
  // No opacity: fading an opaque card over the live transcript reads as a
  // crossfade (card text, transcript, and bar all half-visible at once).
  // Instead the card stays opaque and slides its full height down past the
  // clipping window's bottom edge, so the transcript is only revealed where
  // the card has physically left.
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const progress = cardProgress === undefined ? 1 : cardProgress.value;
    return {
      transform: [{ translateY: (1 - progress) * cardHeight.value }],
    };
  });

  // On iOS the card stays MOUNTED while collapsed (hidden via the animated
  // style): expanding animates existing views on the UI thread the same
  // frame the host starts the progress timing, instead of paying a React
  // mount + layout before anything moves.
  const renderCard = EXPANDED_CARD_IS_OVERLAY || !props.collapsed;
  const showBar = props.collapsed || EXPANDED_CARD_IS_OVERLAY;
  // The bar renders UNDER the card (earlier in JSX), always opaque: while
  // expanded the opaque card covers it, and during the collapse slide the
  // card's top edge wipes past and reveals it — no opacity handoff, so no
  // crossfade frames.
  const stopButton = props.onStopThread ? (
    <ControlPill
      accessibilityLabel="Stop"
      icon="stop.fill"
      variant="danger"
      disabled={!props.canOperateThread}
      onPress={props.onStopThread}
    />
  ) : null;
  const bar = showBar ? (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand user input, ${questionCount} question${
          questionCount === 1 ? "" : "s"
        }`}
        onPress={props.onToggleCollapsed}
        className="min-h-[44px] flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        {mascotReady ? <HarnessMascot state="waiting" size={24} visible={props.collapsed} /> : null}
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
          {asks
            ? questionCount === 1
              ? "Question from the agent"
              : `${questionCount} questions from the agent`
            : "Your input is needed"}
        </Text>
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
      {stopButton}
    </View>
  ) : null;
  const card = renderCard ? (
    // The surface is opaque on purpose: the card floats over the thread
    // feed with no blur behind it, so a translucent background renders
    // the questions on top of whatever message happens to sit underneath.
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      entering={
        EXPANDED_CARD_IS_OVERLAY
          ? undefined
          : FadeInUp.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))
      }
      exiting={
        EXPANDED_CARD_IS_OVERLAY
          ? undefined
          : FadeOutDown.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))
      }
      layout={CARD_LAYOUT_TRANSITION}
      className="overflow-hidden gap-2.5 rounded-[20px] border-continuous border border-border bg-card-alt p-4"
      style={[
        keyboardHeightStyle,
        EXPANDED_CARD_IS_OVERLAY && cardAnimatedStyle,
        discord && { borderRadius: 4, borderLeftWidth: 3, borderLeftColor: "#5865F2" },
      ]}
    >
      {/* Stop stays reachable here too: the expanded card hides the collapsed bar. */}
      <View
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        className="flex-row items-center gap-2"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Collapse user input"
          onPress={props.onToggleCollapsed}
          className="min-h-[44px] flex-1 flex-row items-center gap-2"
        >
          {mascotReady ? (
            <HarnessMascot state="waiting" size={24} visible={!props.collapsed} />
          ) : null}
          <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">{eyebrow}</Text>
          <View className="h-8 w-8 items-center justify-center rounded-full border border-input-border bg-grouped-card">
            <SymbolView
              name="chevron.down"
              size={13}
              tintColorClassName={"accent-icon-subtle"}
              type="monochrome"
            />
          </View>
        </Pressable>
        {stopButton}
      </View>
      <KeyboardAwareScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        // The list is a Reanimated scroll view. Its prop types only mention
        // RN styles, but it applies an animated max height so the custom
        // answer can scroll above the keyboard.
        style={[{ flexShrink: 1 }, scrollMaxHeight] as unknown as StyleProp<ViewStyle>}
        bottomOffset={footerHeight + heightConstraints.composerOverlapHeight + 44}
      >
        {asks ? (
          <Text className="text-xs text-foreground-muted">
            You can answer while the agent works.
          </Text>
        ) : null}
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </Text>
        ) : null}
        {props.pendingUserInput.questions.map((question) => {
          const draft = props.drafts[question.id];
          return (
            <View key={question.id} className="gap-2 pt-1">
              <Text className="font-t3-medium text-xs text-foreground-muted">
                {question.header}
              </Text>
              <QuestionText markdown={question.question} />
              <View className="gap-2">
                {question.options.map((option) => {
                  const optionValue = option.value ?? option.label.trim();
                  const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                  const description =
                    option.description !== option.label ? option.description : undefined;
                  return (
                    <Pressable
                      key={optionValue}
                      accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                      accessibilityState={{ checked: selected, disabled: responseDisabled }}
                      disabled={responseDisabled}
                      className={cn(
                        "min-h-[44px] w-full flex-row items-start gap-2.5 rounded-2xl border-continuous border px-3 py-2.5 active:opacity-75",
                        selected ? "border-primary bg-primary/10" : "border-border bg-input",
                      )}
                      onPress={() =>
                        props.onSelectOption(
                          props.pendingUserInput.requestId,
                          question,
                          optionValue,
                        )
                      }
                    >
                      <View
                        className={cn(
                          "mt-0.5 size-[18px] shrink-0 items-center justify-center border",
                          question.multiSelect ? "rounded-[5px]" : "rounded-full",
                          selected ? "border-primary bg-primary" : "border-foreground-tertiary",
                        )}
                      >
                        {selected ? (
                          <SymbolView
                            name="checkmark"
                            size={10}
                            tintColorClassName="accent-primary-foreground"
                            type="monochrome"
                          />
                        ) : null}
                      </View>
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="font-t3-medium text-sm text-foreground">
                          {option.label}
                        </Text>
                        {description ? (
                          <Text className="font-sans text-sm leading-5 text-foreground-muted">
                            {description}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              {question.allowCustomAnswer !== false ? (
                <QuestionAttachments
                  requestId={props.pendingUserInput.requestId}
                  question={question}
                  questions={props.pendingUserInput.questions}
                  disabled={responseDisabled}
                  value={draft?.customAnswer ?? ""}
                  onChangeText={(value) =>
                    props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                  }
                  onInputFocusChange={props.onInputFocusChange}
                />
              ) : null}
            </View>
          );
        })}
      </KeyboardAwareScrollView>
      <View
        className="gap-2.5"
        onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
      >
        {/* One row: the quiet way out on the left, the answer taking the rest. */}
        <View className="flex-row items-center gap-1.5">
          {props.pendingUserInput.dismissible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={asks ? "Dismiss" : "Dismiss without answering"}
              className="min-h-[44px] items-center justify-center rounded-2xl px-3.5 active:opacity-70 disabled:opacity-50"
              disabled={isResponding}
              onPress={() => void props.onDismiss()}
            >
              <Text className="font-t3-bold text-sm text-foreground-muted">Dismiss</Text>
            </Pressable>
          ) : null}
          {/* Outlined while there is nothing to send, so it still reads as the button. */}
          <View
            className={cn(
              "min-w-0 flex-1 rounded-2xl border",
              sendDisabled ? "border-border" : "border-transparent",
            )}
          >
            <RequestActionButton
              label={
                props.deliveryStatus
                  ? isResponding
                    ? props.deliveryStatus
                    : "Try again"
                  : isResponding
                    ? "Sending…"
                    : asks
                      ? "Send answer"
                      : "Submit answers"
              }
              size="large"
              tone={props.answers && !isResponding ? "primary" : "secondary"}
              accessibilityState={{ busy: isResponding }}
              disabled={sendDisabled}
              onPress={() => void props.onSubmit()}
            />
          </View>
        </View>
        {props.deliveryStatus ? (
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
            {props.deliveryStatus}
          </Text>
        ) : null}
        {!props.canOperateThread ? (
          <Text className="font-sans text-xs text-foreground-tertiary">
            This connection cannot submit answers.
          </Text>
        ) : null}
      </View>
    </Animated.View>
  ) : null;
  return (
    <View className="relative">
      {bar}
      {EXPANDED_CARD_IS_OVERLAY ? (
        // Clipping window for the collapse slide: same footprint as the
        // expanded card, bottom edge on the bar's bottom edge. The sliding
        // card exits through the bottom edge instead of drawing over the
        // composer area, wiping the bar (and the transcript) into view.
        <View
          pointerEvents={props.collapsed ? "none" : "box-none"}
          className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
          style={{ height: maxHeight }}
        >
          {card}
        </View>
      ) : (
        card
      )}
    </View>
  );
}
