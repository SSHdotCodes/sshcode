import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelManagerReply,
} from "@t3tools/contracts";
import {
  MODEL_MANAGER_APPROVAL_OPTIONS,
  modelManagerBoxView,
  modelManagerQuestionAnswers,
  toggleModelManagerOption,
} from "@t3tools/client-runtime/model-manager-box";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SecretRequestCard } from "./SecretRequestCard";

function Action(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center px-2 active:opacity-60"
    >
      <Text
        className={
          props.disabled
            ? "text-sm text-foreground-muted"
            : "text-sm font-t3-medium text-primary-text"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ModelManagerBox(props: {
  environmentId: EnvironmentId;
  reply: ModelManagerReply;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const state = useEnvironmentThread(props.environmentId, props.reply.threadId);
  const projection = Option.getOrNull(state.data);
  const view = modelManagerBoxView(projection, props.reply);
  const allowed = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const transcript = useRef<ScrollViewInstance>(null);
  const following = useRef(true);
  const submit = async () => {
    if (!text.trim() || props.sending || !allowed) return;
    if (await props.onSend(text)) setText("");
  };
  return (
    <View accessibilityLabel="Models assistant" className="px-4 py-2">
      <Text accessibilityLiveRegion="polite" className="mb-2 text-xs text-foreground-muted">
        {view.label}
      </Text>
      <ScrollView
        ref={transcript}
        onContentSizeChange={() => {
          if (following.current) transcript.current?.scrollToEnd({ animated: false });
        }}
        onScroll={(event) => {
          const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
          following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 32;
        }}
        scrollEventThrottle={100}
        nestedScrollEnabled
        style={{ maxHeight: 240 }}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Models transcript"
      >
        {view.messages.map((message) => (
          <View key={message.id} className="mb-2">
            <Text className="text-xs text-foreground-muted">
              {message.role === "user" ? "You" : "Models"}
            </Text>
            <Text selectable className="text-sm text-foreground">
              {message.text}
            </Text>
          </View>
        ))}
        {projection === null ? (
          <Text className="text-sm text-foreground-muted">Loading assistant…</Text>
        ) : null}
        {view.pending.approvals.map((approval) => (
          <View key={approval.requestId} className="my-2">
            <Text className="text-sm text-foreground">{approval.detail ?? "Approval needed"}</Text>
            <View className="flex-row flex-wrap">
              {(approval.options ?? MODEL_MANAGER_APPROVAL_OPTIONS).map((option) => (
                <Action
                  key={option.decision}
                  label={option.label}
                  disabled={busy || !allowed || approval.responseCapability !== "live"}
                  onPress={async () => {
                    if (inFlight.current) return;
                    inFlight.current = true;
                    setBusy(true);
                    const result = await respond({
                      environmentId: props.environmentId,
                      input: {
                        threadId: props.reply.threadId,
                        requestId: approval.requestId,
                        decision: option.decision,
                      },
                    });
                    inFlight.current = false;
                    setBusy(false);
                    setError(
                      result._tag === "Success" || isAtomCommandInterrupted(result)
                        ? null
                        : "Could not send the answer. Try again.",
                    );
                  }}
                />
              ))}
            </View>
            {approval.responseCapability !== "live" ? (
              <Text className="text-xs text-foreground-muted">
                This request is no longer available. Send a reply to try again.
              </Text>
            ) : null}
          </View>
        ))}
        {view.pending.userInputs.map((request) => (
          <ModelManagerQuestion
            key={request.requestId}
            environmentId={props.environmentId}
            reply={props.reply}
            request={request}
          />
        ))}
        {view.secrets.map((row) => (
          <SecretRequestCard
            key={row.item.id}
            environmentId={props.environmentId}
            projectedItem={row}
            iconColor="#888888"
          />
        ))}
      </ScrollView>
      {view.activity ? (
        <Text numberOfLines={1} className="mt-1 text-xs text-foreground-muted">
          {view.activity}
        </Text>
      ) : null}
      {error || Option.getOrNull(state.error) ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error ?? Option.getOrNull(state.error)}
        </Text>
      ) : null}
      <View className="mt-1 flex-row items-center gap-2">
        <TextInput
          accessibilityLabel="Reply to Models"
          className="min-h-11 min-w-0 flex-1 text-sm text-foreground"
          placeholder="Reply or ask for another change"
          placeholderTextColorClassName="accent-placeholder"
          value={text}
          onChangeText={setText}
          editable={allowed}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        <Action
          label={props.sending ? "Sending…" : "Send"}
          disabled={!allowed || props.sending || !text.trim()}
          onPress={submit}
        />
      </View>
    </View>
  );
}

function ModelManagerQuestion(props: {
  environmentId: EnvironmentId;
  reply: ModelManagerReply;
  request: ThreadPendingUserInput;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const allowed = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const answers = modelManagerQuestionAnswers(props.request, selected, custom);
  const disabled = busy || !allowed || props.request.responseCapability === "not_resumable";
  return (
    <View className="my-2 gap-2" accessibilityLabel="Models question">
      {props.request.questions.map((question) => (
        <View key={question.id}>
          <Text className="text-sm text-foreground">{question.question}</Text>
          {question.options.map((option) => {
            const value = option.value ?? option.label;
            return (
              <Pressable
                key={value}
                accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                accessibilityState={{
                  checked: (selected[question.id] ?? []).includes(value),
                  disabled,
                }}
                disabled={disabled}
                className="min-h-11 justify-center py-2"
                onPress={() => {
                  setSelected((current) => ({
                    ...current,
                    [question.id]: toggleModelManagerOption(
                      current[question.id] ?? [],
                      value,
                      question.multiSelect,
                    ),
                  }));
                  setCustom((current) => ({ ...current, [question.id]: "" }));
                }}
              >
                <Text className="text-sm text-primary-text">
                  {(selected[question.id] ?? []).includes(value) ? "✓ " : ""}
                  {option.label}
                </Text>
                {option.description ? (
                  <Text className="text-xs text-foreground-muted">{option.description}</Text>
                ) : null}
              </Pressable>
            );
          })}
          {question.allowCustomAnswer !== false ? (
            <TextInput
              accessibilityLabel={`Answer: ${question.header}`}
              className="min-h-11 text-sm text-foreground"
              placeholder="Your answer"
              placeholderTextColorClassName="accent-placeholder"
              value={custom[question.id] ?? question.initialAnswer ?? ""}
              editable={!disabled}
              onChangeText={(value) =>
                setCustom((current) => ({ ...current, [question.id]: value }))
              }
            />
          ) : null}
        </View>
      ))}
      {props.request.responseCapability === "not_resumable" ? (
        <Text className="text-xs text-foreground-muted">
          This request is no longer available. Send a reply to try again.
        </Text>
      ) : null}
      <Action
        label={busy ? "Sending…" : "Answer"}
        disabled={disabled || answers === null}
        onPress={async () => {
          if (answers === null || inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          const result = await respond({
            environmentId: props.environmentId,
            input: { threadId: props.reply.threadId, requestId: props.request.requestId, answers },
          });
          inFlight.current = false;
          setBusy(false);
          setError(
            result._tag === "Success" || isAtomCommandInterrupted(result)
              ? null
              : "Could not send the answer. Try again.",
          );
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
