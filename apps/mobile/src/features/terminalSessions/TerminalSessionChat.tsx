import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ClaudeRcItem, ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { UserMessageBubble } from "../threads/UserMessageBubble";
import { ComposerEditor } from "../../native/T3ComposerEditor";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { MaterialButton } from "../../components/MaterialButton";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { claudeRcEnvironment } from "../../state/claudeRc";
import {
  TERMINAL_MESSAGE_MAX_LENGTH,
  composerTextAfterSend,
  terminalCommandFailure,
} from "@t3tools/client-runtime/terminal-sessions";

export function TerminalSessionChat(props: {
  readonly environmentId: EnvironmentId;
  readonly session: ClaudeRcSession;
  readonly onClose: () => void;
  readonly hostMessage?: string | null;
  readonly hostReady?: boolean;
}) {
  const watch = useEnvironmentQuery(
    claudeRcEnvironment.watch({
      environmentId: props.environmentId,
      input: { sessionId: props.session.id },
    }),
  );
  const allowed = useAtomValue(claudeRcEnvironment.command.permissionAtom(props.environmentId));
  const run = useAtomCommand(claudeRcEnvironment.command, { reportFailure: false });
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followRef = useRef(true);
  const state = watch.data;
  const items = state?.items ?? [];
  const tail = items.at(-1);
  const transcriptTail = `${items.length}:${tail?.id ?? ""}:${tail?.text.length ?? 0}`;

  useEffect(() => {
    if (transcriptTail.length === 0) return;
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, [transcriptTail]);

  const connected = props.hostReady !== false && state?.phase === "connected" && !watch.error;
  const canSend = connected && allowed;
  const send = async () => {
    const draft = text.trim();
    if (!canSend || draft.length === 0 || sending) return;
    if (draft.length > TERMINAL_MESSAGE_MAX_LENGTH) {
      setSendError("That message is too long.");
      return;
    }
    setSending(true);
    setSendError(null);
    const result = await run({
      environmentId: props.environmentId,
      input: { action: "send", sessionId: props.session.id, text: draft },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText((current) => composerTextAfterSend(current, draft, true));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setSendError(terminalCommandFailure(squashAtomCommandFailure(result), "Could not send."));
    }
  };

  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    const result = await run({
      environmentId: props.environmentId,
      input: { action: "interrupt", sessionId: props.session.id },
    });
    setInterrupting(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setSendError(terminalCommandFailure(squashAtomCommandFailure(result), "Could not stop."));
  };

  const decide = async (requestId: string, allow: boolean) => {
    const result = await run({
      environmentId: props.environmentId,
      input: { action: "permission", sessionId: props.session.id, requestId, allow },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setSendError(
      terminalCommandFailure(squashAtomCommandFailure(result), "Could not answer that request."),
    );
  };

  const phaseMessage =
    props.hostMessage ??
    watch.error ??
    (state?.phase === "disconnected"
      ? (state.message ?? "Disconnected. Reconnect or return to Terminal sessions.")
      : state?.phase === "connecting" || state === null
        ? (state?.message ?? "Connecting…")
        : state.message);

  return (
    <SafeAreaView className="flex-1 bg-screen" edges={["bottom"]}>
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-4 py-4"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
          onScroll={(event) => {
            const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
            followRef.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          }}
          scrollEventThrottle={100}
        >
          {items.map((item, index) => (
            <TerminalSessionMessage
              key={item.id}
              item={item}
              streaming={
                state?.working === true && index === items.length - 1 && item.role === "assistant"
              }
            />
          ))}
          {(state?.permissions ?? []).map((permission) => (
            <View key={permission.requestId} className="gap-2 rounded-2xl bg-card px-4 py-3">
              <Text className="text-base font-t3-medium text-foreground">
                {permission.toolName}
              </Text>
              <Text className="text-sm text-foreground-muted">{permission.description}</Text>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <MaterialButton
                    fullWidth
                    label="Allow"
                    disabled={!canSend}
                    onPress={() => void decide(permission.requestId, true)}
                  />
                </View>
                <View className="flex-1">
                  <MaterialButton
                    fullWidth
                    tone="secondary"
                    label="Deny"
                    disabled={!canSend}
                    onPress={() => void decide(permission.requestId, false)}
                  />
                </View>
              </View>
            </View>
          ))}
        </ScrollView>
        <View className="gap-2 px-3 pt-2 pb-3">
          {phaseMessage ? (
            <Text accessibilityRole="text" className="text-xs text-foreground-muted">
              {phaseMessage}
            </Text>
          ) : null}
          {!connected &&
          (watch.error || state?.phase === "disconnected" || props.hostReady === false) ? (
            <View className="flex-row gap-2">
              <MaterialButton
                tone="text"
                label="Back to Terminal sessions"
                onPress={props.onClose}
              />
              <MaterialButton tone="text" label="Reconnect" onPress={() => watch.refresh()} />
            </View>
          ) : null}
          {sendError ? <Text className="text-sm text-danger-foreground">{sendError}</Text> : null}
          {!allowed ? (
            <Text className="text-xs text-foreground-muted">
              This connection needs permission to operate chats.
            </Text>
          ) : null}
          <View className="flex-row items-end gap-2 rounded-[27px] bg-card px-3 py-2">
            <View className="min-w-0 flex-1">
              <ComposerEditor
                multiline
                value={text}
                placeholder="Message the terminal session"
                onChangeText={setText}
                onSubmit={() => void send()}
                enterBehavior="send"
                submitTitle="Send"
                style={{ minHeight: 40, maxHeight: 144 }}
              />
            </View>
            {state?.working ? (
              <ComposerActionButton
                accessibilityLabel="Stop"
                icon="stop.fill"
                variant="danger"
                disabled={!canSend || interrupting}
                onPress={() => void interrupt()}
              />
            ) : null}
            <ComposerActionButton
              accessibilityLabel="Send"
              icon="arrow.up"
              disabled={!canSend || sending || text.trim().length === 0}
              onPress={() => void send()}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TerminalSessionMessage(props: {
  readonly item: ClaudeRcItem;
  readonly streaming: boolean;
}) {
  const styles = useMarkdownPreviewStyles(props.item.role === "user" ? "user" : "default");
  const [expanded, setExpanded] = useState(false);
  if (props.item.role === "notice")
    return <Text className="py-1 text-xs text-foreground-muted">{props.item.text}</Text>;
  if (props.item.role === "tool")
    return (
      <View className="gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
        >
          <Text className="text-sm text-foreground-muted" numberOfLines={expanded ? undefined : 1}>
            {expanded ? "▾" : "▸"} {props.item.text.split("\n")[0]}
          </Text>
        </Pressable>
        {expanded ? (
          <Text selectable className="pl-4 font-mono text-xs text-foreground-muted">
            {props.item.text}
          </Text>
        ) : null}
      </View>
    );
  const body = (
    <SelectableMarkdownText
      markdown={props.item.text}
      textStyle={styles.nativeTextStyle}
      preserveSoftBreaks
      isStreaming={props.streaming}
      onLinkPress={(href) => {
        if (/^https?:\/\//.test(href)) void Linking.openURL(href);
      }}
    />
  );
  return props.item.role === "user" ? (
    <View className="max-w-[85%] self-end rounded-[20px] bg-user-bubble">
      <UserMessageBubble>{body}</UserMessageBubble>
    </View>
  ) : (
    <View className="min-w-0">{body}</View>
  );
}
