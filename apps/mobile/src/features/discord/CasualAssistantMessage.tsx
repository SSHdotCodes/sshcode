import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, AppState, Pressable, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useReducedMotion } from "react-native-reanimated";
import type {
  CasualVoiceDisplay,
  CasualVoiceRole,
  EnvironmentId,
  ThreadId,
  MessageId,
} from "@t3tools/contracts";
import {
  casualHiddenLabel,
  planCasualReveal,
  casualDisplayParts,
} from "@t3tools/shared/casualVoice";
import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { ThreadMediaVisibleContext } from "../threads/ThreadMarkdownVideo";
import { useCasualMessage, useCasualStatus } from "./useCasualVoice";

function HiddenProse({ original }: { original: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="min-h-11 justify-center"
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="text-xs text-foreground-muted">{casualHiddenLabel(original)}</Text>
      </Pressable>
      {expanded ? <Text className="text-sm text-foreground-muted">{original}</Text> : null}
    </View>
  );
}
function Burst(props: {
  display: CasualVoiceDisplay;
  live: boolean;
  visible: boolean;
  reducedMotion: boolean;
  agent: string;
  render: (text: string, displayOnly: boolean) => ReactNode;
}) {
  const { display, live, visible, reducedMotion } = props;
  const parts = useMemo(() => casualDisplayParts(display), [display]);
  const bubbles = useMemo(() => parts.filter((part) => part.kind === "say"), [parts]);
  const [revealed, setRevealed] = useState(1);
  useEffect(() => {
    const plan = planCasualReveal(
      bubbles.map((part) => part.text.length),
      { live, visible, reducedMotion },
    );
    if (!live || !visible || reducedMotion) {
      queueMicrotask(() => setRevealed(bubbles.length));
      return;
    }
    const timers = plan.map((at, index) =>
      setTimeout(() => setRevealed((prior) => Math.max(prior, index + 1)), at),
    );
    return () => timers.forEach(clearTimeout);
  }, [bubbles, live, visible, reducedMotion]);
  const count = !live || !visible || reducedMotion ? bubbles.length : revealed;
  return (
    <View>
      {parts.map((part) =>
        part.kind === "hide" ? (
          <HiddenProse key={part.id} original={part.original} />
        ) : part.kind === "say" && part.ordinal < count ? (
          <View key={part.id} accessibilityLabel={`${props.agent} message`} className="mb-2">
            {props.render(part.text, true)}
          </View>
        ) : null,
      )}
      {count < bubbles.length ? (
        <Text accessibilityRole="text" className="text-xs text-foreground-muted">
          {props.agent} is typing…
        </Text>
      ) : null}
    </View>
  );
}
export function CasualWorkStatus(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  runId: string | null;
  active: boolean;
}) {
  const status = useCasualStatus(props.environmentId, props.threadId, props.runId, props.active);
  return status ? (
    <Text accessibilityRole="text" className="text-xs text-foreground-muted">
      {status}
    </Text>
  ) : null;
}
function DiscordCasualAssistantMessage(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: MessageId;
  runId: string | null;
  role: CasualVoiceRole;
  original: string;
  streaming: boolean;
  discord: boolean;
  agent: string;
  children: (text: string, displayOnly: boolean) => ReactNode;
}) {
  const rowVisible = useContext(ThreadMediaVisibleContext);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const visible = rowVisible && focused && foreground;
  const initialReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  useEffect(() => {
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);
  const casual = useCasualMessage(
    props.environmentId,
    props.threadId,
    props.messageId,
    props.original,
    props.streaming,
    props.discord,
    props.runId,
    props.role,
    visible,
  );
  if (!props.discord) return props.children(props.original, false);
  return (
    <>
      {casual.display ? (
        <Burst
          display={casual.display}
          live={casual.live}
          visible={visible}
          reducedMotion={reducedMotion}
          agent={props.agent}
          render={props.children}
        />
      ) : (
        props.children(props.original, false)
      )}
      {!props.runId && casual.display ? (
        <View>
          {casual.display.blocks
            .filter((block) => block.kind === "status")
            .map((block) => (
              <Text key={block.from} className="text-xs text-foreground-muted">
                {block.text}
              </Text>
            ))}
        </View>
      ) : null}
      {casual.rewritten ? (
        <View className="flex-row gap-4">
          <Pressable
            className="min-h-11 justify-center"
            accessibilityRole="button"
            onPress={casual.toggle}
          >
            <Text className="text-xs text-foreground-muted">
              {casual.showOriginal ? "show casual" : "show original"}
            </Text>
          </Pressable>
          <Pressable
            className="min-h-11 justify-center"
            accessibilityRole="button"
            onPress={() => void tryCopyTextWithHaptic(props.original)}
          >
            <Text className="text-xs text-foreground-muted">copy original</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

export function CasualAssistantMessage(
  props: Parameters<typeof DiscordCasualAssistantMessage>[0] & { readonly active?: boolean },
) {
  const active = props.active === true;
  if (!active) return props.children(props.original, false);
  return <DiscordCasualAssistantMessage {...props} discord />;
}
