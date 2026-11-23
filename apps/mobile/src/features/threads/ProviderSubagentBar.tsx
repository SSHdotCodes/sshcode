import {
  connectionWorkLabel,
  connectionWorkStatus,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  formatProviderSubagentStatus,
  formatRelayedSentAt,
  type ProviderSubagentStatus,
  type RelayedSubagentMessage,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { FastModeBolt } from "../../components/FastModeBolt";
import { ProviderIcon } from "../../components/ProviderIcon";
import { RequestActionButton } from "./RequestActionButton";
import { useVisibleSecondClock } from "./use-visible-second-clock";

/**
 * Replaces the composer on a provider-native subagent thread. The provider
 * runs that conversation, so a message goes through the parent chat; the bar
 * says which model is working, for how long, and leads back to the parent.
 */
export function ProviderSubagentBar(props: {
  /** Driver and catalog icon of the provider running the subagent. */
  readonly provider: { readonly driver: string; readonly iconUrl?: string | undefined } | null;
  readonly modelLabel: string;
  /** Reasoning effort as the composer names it, when the subagent has one. */
  readonly effortLabel: string | null;
  readonly speedLabel: string | null;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
  readonly connectionState?: EnvironmentConnectionPhase;
  readonly onOpenParent: (() => void) | null;
  /** Sends a message through the parent chat; resolves false when it didn't go. */
  readonly onSendThroughParent: ((text: string) => Promise<boolean>) | null;
  /** What this phone sent through the parent, oldest first. */
  readonly sentThroughParent: ReadonlyArray<RelayedSubagentMessage>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const { onSendThroughParent } = props;
  const send = async () => {
    const text = draft.trim();
    if (text === "" || sending || onSendThroughParent === null) return;
    setSending(true);
    try {
      if (await onSendThroughParent(text)) setDraft("");
    } finally {
      setSending(false);
    }
  };
  const active = props.status !== null && isOrchestrationV2WorkActive(props.status.status);
  const connectionStatus = active ? connectionWorkStatus(props.connectionState) : null;
  const nowMs = useVisibleSecondClock(active && connectionStatus === null);
  const statusLabel =
    connectionStatus === null
      ? formatProviderSubagentStatus(props.status, nowMs)
      : connectionWorkLabel(connectionStatus);
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;

  return (
    <View className="gap-1.5 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      {props.sentThroughParent.map((message) => {
        const sentAt = formatRelayedSentAt(message.sentAt, nowMs);
        return (
          <View
            key={message.sentAt}
            accessible
            accessibilityLabel={`You sent through the parent at ${sentAt}: ${message.text}`}
            className="max-w-[85%] self-end rounded-[16px] bg-subtle px-3 py-1.5"
          >
            <Text numberOfLines={4} className="font-sans text-sm text-foreground">
              {message.text}
            </Text>
            <Text className="font-sans text-xs text-foreground-secondary">
              Sent through the parent · {sentAt}
            </Text>
          </View>
        );
      })}
      <View className="flex-row items-center gap-3">
        {/* Only the text is one element, so "Open parent" stays reachable. */}
        <View
          accessible
          accessibilityLabel={`${modelDescription}${props.speedLabel ? `, ${props.speedLabel} mode on` : ""} subagent, ${statusLabel}.${onSendThroughParent === null ? " It runs on its own and cannot take messages." : ""}`}
          className="min-w-0 flex-1 gap-0.5"
        >
          <View className="min-w-0 flex-row items-center gap-1.5">
            {props.provider ? (
              <ProviderIcon
                iconUrl={props.provider.iconUrl}
                provider={props.provider.driver}
                size={16}
              />
            ) : null}
            <Text numberOfLines={1} className="min-w-0 shrink font-t3-bold text-sm text-foreground">
              {props.modelLabel}
            </Text>
            {props.effortLabel === null ? null : (
              <Text
                numberOfLines={1}
                className="shrink-0 font-sans text-sm text-foreground-secondary"
              >
                {props.effortLabel}
              </Text>
            )}
            {props.speedLabel ? <FastModeBolt /> : null}
          </View>
          <Text
            numberOfLines={1}
            className="font-sans text-xs text-foreground-secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {onSendThroughParent === null ? `${statusLabel} · Runs on its own` : statusLabel}
          </Text>
        </View>
        {props.onOpenParent ? (
          <RequestActionButton label="Open parent" tone="secondary" onPress={props.onOpenParent} />
        ) : null}
      </View>
      {onSendThroughParent === null ? null : (
        <View className="flex-row items-end gap-2">
          <TextInput
            multiline
            value={draft}
            onChangeText={setDraft}
            editable={!sending}
            placeholder="Message this subagent through its parent"
            accessibilityLabel="Message this subagent"
            className="max-h-28 min-h-10 flex-1 rounded-[18px] py-2"
          />
          <View className="pb-0.5">
            <ControlPill
              accessibilityLabel="Send to subagent"
              icon="arrow.up"
              variant="primary"
              disabled={sending || draft.trim().length === 0}
              onPress={() => void send()}
            />
          </View>
        </View>
      )}
    </View>
  );
}
