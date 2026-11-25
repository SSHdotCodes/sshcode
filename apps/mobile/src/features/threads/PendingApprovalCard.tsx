import { useUiMode } from "../discord/useUiMode";
import { HarnessMascot } from "../../components/HarnessMascot";
import { RequestActionButton } from "./RequestActionButton";
import { presentApprovalCard } from "./approvalCard";
import { useAnnounceRequest } from "./use-announce-request";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { ScrollView, View } from "react-native";
import { useState } from "react";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { derivePendingUserInputMaxHeight, questionScrollMaxHeight } from "./pendingUserInputLayout";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly heightConstraints: Omit<
    Parameters<typeof derivePendingUserInputMaxHeight>[0],
    "keyboardHeight"
  >;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const [uiMode] = useUiMode();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const [footerHeight, setFooterHeight] = useState(0);
  const { heightConstraints } = props;
  const scrollStyle = useAnimatedStyle(() => ({
    maxHeight: questionScrollMaxHeight({
      cardMaxHeight: derivePendingUserInputMaxHeight({
        ...heightConstraints,
        keyboardHeight: -keyboardHeight.value,
      }),
      headerHeight: 0,
      footerHeight,
    }),
  }));
  const discord = uiMode === "discord";
  const presentation = presentApprovalCard(props.approval);
  useAnnounceRequest(props.approval.requestId, `Approval needed. ${presentation.title}`);
  const warning = (props.approval.options ?? []).find((option) => option.warning)?.warning;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  const canRespond = props.approval.responseCapability === "live";
  const responding = props.respondingApprovalId === props.approval.requestId;
  const disabled = !canRespond || responding || !props.canOperateThread;
  const respond = (decision: ProviderApprovalDecision) => {
    if (disabled) return;
    void Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(
      () => undefined,
    );
    void props.onRespond(props.approval.requestId, decision);
  };
  const allow = presentation.allow;
  const deny = presentation.deny;
  return (
    <View
      className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={
        discord ? { borderRadius: 4, borderLeftWidth: 3, borderLeftColor: "#F0B232" } : undefined
      }
    >
      <Animated.View style={scrollStyle}>
        <ScrollView nestedScrollEnabled contentContainerClassName="gap-2.5">
          <View className="flex-row items-center gap-2">
            <HarnessMascot state="waiting" size={24} />
            <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
              Approval needed
            </Text>
          </View>
          <Text className="font-t3-bold text-lg text-foreground">{presentation.title}</Text>
          {presentation.appName ? (
            <Text className="font-sans text-sm text-foreground-secondary">
              {presentation.appName}
            </Text>
          ) : null}
          {presentation.detail ? (
            <Text selectable className="font-sans text-sm leading-normal text-foreground-secondary">
              {presentation.detail}
            </Text>
          ) : null}
          {!canRespond ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              The provider process for this request is no longer available. Interrupt or restart the
              run to continue.
            </Text>
          ) : null}
          {warning ? (
            <Text className="font-sans text-xs leading-normal text-warning-foreground">
              {warning}
            </Text>
          ) : null}
        </ScrollView>
      </Animated.View>
      <View
        className="gap-2.5"
        onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
      >
        {responding ? (
          <RequestActionButton
            label="Sending…"
            tone="secondary"
            size="large"
            disabled
            accessibilityState={{ busy: true }}
          />
        ) : (
          <>
            {allow || deny ? (
              <View className="flex-row gap-2.5">
                {deny ? (
                  <View className="min-w-0 flex-1">
                    <RequestActionButton
                      label={deny.label}
                      tone="danger"
                      size="large"
                      disabled={disabled}
                      accessibilityState={{ disabled }}
                      onPress={() => respond(deny.decision)}
                    />
                  </View>
                ) : null}
                {allow ? (
                  <View className="min-w-0 flex-1">
                    <RequestActionButton
                      label={allow.label}
                      tone={discord ? "success" : "primary"}
                      size="large"
                      disabled={disabled}
                      accessibilityState={{ disabled }}
                      onPress={() => respond(allow.decision)}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
            {presentation.secondary.map((option) => (
              <RequestActionButton
                key={option.decision}
                label={option.label}
                tone="secondary"
                size="large"
                disabled={disabled}
                onPress={() => respond(option.decision)}
              />
            ))}
          </>
        )}
        {!props.canOperateThread ? (
          <Text className="font-sans text-xs text-foreground-muted">
            This connection cannot respond to approvals.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
