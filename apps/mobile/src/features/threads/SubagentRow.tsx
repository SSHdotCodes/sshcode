import {
  resolveSubagentMetadata,
  SUBAGENT_SPEED_LABELS,
  type SubagentSpeed,
  subagentSeenLine,
  subagentSpeed,
} from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { SubagentSpeedBadge } from "./SubagentSpeedBadge";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { subagentCardDetail } from "./subagent-card-presentation";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import {
  type SubagentRowPresentation,
  resolveSubagentRowPresentation,
} from "./threadAgentsPresentation";

type SubagentRowSubagent = Pick<
  OrchestrationV2Subagent,
  | "remote"
  | "threadId"
  | "childThreadId"
  | "model"
  | "modelSelection"
  | "driver"
  | "providerInstanceId"
  | "title"
  | "prompt"
  | "status"
  | "progress"
  | "result"
  | "seen"
>;

/** Callers own the press target and elapsed timer so ticking stays isolated. */
export function SubagentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
  readonly elapsed: ReactNode;
  readonly statusLabel?: string;
  readonly grade?: ReactNode;
}) {
  const childEnvironmentId = props.subagent.remote?.environmentId ?? props.environmentId;
  const connection = useRemoteEnvironmentRuntime(childEnvironmentId);
  const config = useEnvironmentServerConfig(childEnvironmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === props.subagent.providerInstanceId,
  );
  const original = resolveSubagentRowPresentation(props.subagent);
  const presentation = resolveSubagentRowPresentation(props.subagent, connection?.connectionState);
  const paused = original.live && !presentation.live;
  return (
    <SubagentCardRow
      presentation={
        props.statusLabel ? { ...presentation, statusLabel: props.statusLabel } : presentation
      }
      driver={provider?.driver ?? props.subagent.driver}
      iconUrl={provider?.iconUrl}
      speed={subagentSpeed(props.subagent.modelSelection)}
      elapsed={paused ? null : props.elapsed}
      metadata={<SubagentMetadata environmentId={props.environmentId} subagent={props.subagent} />}
      grade={props.grade}
    />
  );
}

/** Shared card body; callers supply their own live state and press target. */
export function SubagentCardRow(props: {
  readonly presentation: SubagentRowPresentation;
  readonly driver: ProviderDriverKind;
  readonly iconUrl?: string | null | undefined;
  readonly speed?: SubagentSpeed | null | undefined;
  readonly elapsed: ReactNode;
  readonly metadata: ReactNode;
  readonly preview?: string | null;
  /** The lead's grade chip; it ends the status line, under the time. */
  readonly grade?: ReactNode;
}) {
  const { presentation } = props;
  const detail = subagentCardDetail(presentation.detail);
  const preview = subagentCardDetail(props.preview ?? null);
  return (
    <View className="min-h-[44px] flex-row items-center gap-[10px]">
      <View className="relative h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-subtle">
        <ProviderIcon provider={props.driver} iconUrl={props.iconUrl} size={15} />
        <View className="absolute -right-px -bottom-px rounded-full border-2 border-screen">
          <SubagentStatusDot tone={presentation.tone} placement="sheet" />
        </View>
        {props.speed ? <SubagentSpeedBadge speed={props.speed} /> : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        {/* The time shares the title's line and the status sits with the model:
            beside a cut-off title the status read as part of the time. */}
        <View className="min-w-0 flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
            {presentation.title}
          </Text>
          {props.elapsed}
        </View>
        <View className="min-w-0 flex-row items-center gap-1">
          <Text
            numberOfLines={1}
            className={cn(
              "shrink-0 text-2xs text-foreground-muted",
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {presentation.statusLabel}
          </Text>
          <Text className="shrink-0 text-2xs text-foreground-muted">·</Text>
          <View className="min-w-0 flex-1">{props.metadata}</View>
          {props.grade}
        </View>
        {detail ? (
          <Text
            numberOfLines={2}
            className={cn(
              "text-xs text-foreground-muted",
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {detail}
          </Text>
        ) : null}
        {preview ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {preview}
          </Text>
        ) : null}
      </View>
      {presentation.canOpenThread ? (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      ) : null}
    </View>
  );
}

/** Uses the same model labels as the Mac without loading child transcripts. */
export function SubagentMetadata(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: Pick<
    SubagentRowSubagent,
    "remote" | "model" | "providerInstanceId" | "seen" | "modelSelection"
  >;
  readonly createdChat?: boolean;
  readonly effort?: string | undefined;
}) {
  const { environmentId, subagent } = props;
  const config = useEnvironmentServerConfig(subagent.remote?.environmentId ?? environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const { modelLabel } = resolveSubagentMetadata({ model: subagent.model, provider });
  const speed = subagentSpeed(subagent.modelSelection);
  return (
    <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
      {props.createdChat ? "Chat · " : ""}
      {[
        modelLabel,
        props.effort,
        speed ? SUBAGENT_SPEED_LABELS[speed] : null,
        subagentSeenLine(subagent),
      ]
        .filter(Boolean)
        .join(" · ")}
    </Text>
  );
}
