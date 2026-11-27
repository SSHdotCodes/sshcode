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
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { SubagentSpeedBadge } from "./SubagentSpeedBadge";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { subagentCardDetail } from "./subagent-card-presentation";
import { LiveProgressCompact } from "./LiveProgress";
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

/** Same frame for live, completed, and created-chat rows in the transcript. */
export const SUBAGENT_TRANSCRIPT_CARD_CLASS_NAME =
  "min-h-[44px] rounded-xl border-continuous border border-border-subtle bg-card px-2.5 py-1.5 active:bg-subtle";

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
  // A subagent leading its own subagents says so; otherwise they show only inside its chat.
  const childShell = useThreadShell(
    props.subagent.childThreadId
      ? scopeThreadRef(childEnvironmentId, props.subagent.childThreadId)
      : null,
  );
  const nestedRunning = presentation.live
    ? (childShell?.longRunningWork?.runningSubagentCount ?? 0)
    : 0;
  // Token use High: the subagent's bar, time left and latest update ride on its chat's shell.
  const liveProgress = presentation.live ? childShell?.source.liveProgress : undefined;
  return (
    <SubagentCardRow
      presentation={
        props.statusLabel ? { ...presentation, statusLabel: props.statusLabel } : presentation
      }
      driver={provider?.driver ?? props.subagent.driver}
      iconUrl={provider?.iconUrl}
      speed={subagentSpeed(props.subagent.modelSelection)}
      elapsed={paused ? null : props.elapsed}
      metadata={
        <SubagentMetadata
          environmentId={props.environmentId}
          subagent={props.subagent}
          nestedRunning={nestedRunning}
        />
      }
      grade={props.grade}
      progress={liveProgress ? <LiveProgressCompact progress={liveProgress} /> : null}
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
  /** Live progress under the text (token use High). */
  readonly progress?: ReactNode;
}) {
  const { presentation } = props;
  const detail = subagentCardDetail(presentation.detail);
  const preview = subagentCardDetail(props.preview ?? null);
  return (
    <View className="min-h-[44px] flex-row items-center gap-[10px]">
      <View
        className={cn(
          "relative size-[28px] shrink-0 items-center justify-center rounded-full bg-subtle",
          (detail || preview || props.progress) && "mt-0.5 self-start",
        )}
      >
        <ProviderIcon provider={props.driver} iconUrl={props.iconUrl} size={15} />
        <View className="absolute -right-px -bottom-px rounded-full border-2 border-subtle">
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
              "max-w-[55%] shrink text-xs text-foreground-muted",
              presentation.tone === "working" && SUBAGENT_TONE_TEXT_CLASS.working,
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {presentation.statusLabel}
          </Text>
          <Text className="shrink-0 text-xs text-foreground-tertiary">·</Text>
          <View className="min-w-0 flex-1">{props.metadata}</View>
          {props.grade}
        </View>
        {detail ? (
          <Text
            numberOfLines={2}
            className={cn(
              "text-xs leading-4 text-foreground-muted",
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
        {props.progress}
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
  /** Subagents this one is running itself. */
  readonly nestedRunning?: number;
}) {
  const { environmentId, subagent } = props;
  const config = useEnvironmentServerConfig(subagent.remote?.environmentId ?? environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const { modelLabel } = resolveSubagentMetadata({
    model: subagent.model,
    modelOptions: subagent.modelSelection?.options,
    provider,
  });
  const speed = subagentSpeed(subagent.modelSelection);
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
      {props.createdChat ? "Chat · " : ""}
      {[
        // An unknown model says nothing here; "Not reported" read as the subagent not reporting.
        subagent.model?.trim() ? modelLabel : null,
        props.effort,
        speed ? SUBAGENT_SPEED_LABELS[speed] : null,
        subagentSeenLine(subagent),
        props.nestedRunning
          ? `${props.nestedRunning} ${props.nestedRunning === 1 ? "subagent" : "subagents"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </Text>
  );
}

/** agy's built-in image generator: the picture is its result, so the card shows it. */
export const IMAGE_GENERATOR_NATIVE_TYPE = "image-generator";

/**
 * Header for a subagent that only paints: a photo mark instead of the provider
 * logo, and a status about the picture. The picture itself sits under the card
 * (see ImageGenerationPictures) so tapping it opens the image, not the chat.
 */
export function ImageGenerationRow(props: {
  readonly title: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly imageCount: number;
  readonly elapsed: ReactNode;
  readonly canOpenThread: boolean;
}) {
  const working =
    props.status === "pending" || props.status === "running" || props.status === "waiting";
  const tone = working
    ? "working"
    : props.status === "failed"
      ? "failed"
      : props.imageCount > 0
        ? "completed"
        : "stopped";
  const statusLabel = working
    ? "Generating image…"
    : props.status === "failed"
      ? "Failed"
      : props.imageCount > 0
        ? "Image ready"
        : props.status === "cancelled" || props.status === "interrupted"
          ? "Stopped"
          : "No image";
  return (
    <View className="min-h-[44px] flex-row items-center gap-[10px]">
      <View className="relative size-[28px] shrink-0 items-center justify-center rounded-full bg-subtle">
        <SymbolView name="photo" size={14} tintColorClassName="accent-icon-subtle" />
        <View className="absolute -right-px -bottom-px rounded-full border-2 border-subtle">
          <SubagentStatusDot tone={tone} placement="sheet" />
        </View>
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-w-0 flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
            {props.title}
          </Text>
          {props.elapsed}
        </View>
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          <Text className={SUBAGENT_TONE_TEXT_CLASS[tone]}>{statusLabel}</Text>
          {" · "}
          {props.imageCount > 1 ? `${props.imageCount} tries · last one kept` : "Image generation"}
        </Text>
      </View>
      {props.canOpenThread ? (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      ) : null}
    </View>
  );
}

/** The kept picture full width under the card, or a quiet frame while it is painted. */
export function ImageGenerationPictures(props: {
  readonly imagePaths: ReadonlyArray<string>;
  readonly working: boolean;
  readonly renderImage:
    | ((image: { href: string; alt: string | null; title: string | null }) => ReactNode)
    | undefined;
}) {
  const kept = props.imagePaths[props.imagePaths.length - 1];
  if (kept !== undefined && props.renderImage) {
    return (
      <View className="mt-1.5">{props.renderImage({ href: kept, alt: null, title: null })}</View>
    );
  }
  if (!props.working) return null;
  return (
    <View
      accessibilityLabel="Generating image"
      className="mt-1.5 aspect-[4/3] w-full max-w-[280px] items-center justify-center rounded-xl border-continuous bg-subtle"
    >
      <SymbolView name="photo" size={22} tintColorClassName="accent-icon-subtle" />
    </View>
  );
}

/**
 * Header for a subagent that finds things out: binoculars instead of the provider logo
 * and a status about the research. The report's opening and its sites sit under the
 * card (see ResearchReport), so tapping a site opens it rather than the chat.
 */
export function ResearchRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: Pick<
    SubagentRowSubagent,
    "remote" | "model" | "providerInstanceId" | "modelSelection"
  >;
  readonly title: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly pages: number;
  readonly elapsed: ReactNode;
  readonly canOpenThread: boolean;
}) {
  const { subagent } = props;
  const config = useEnvironmentServerConfig(subagent.remote?.environmentId ?? props.environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const { modelLabel } = resolveSubagentMetadata({
    model: subagent.model,
    modelOptions: subagent.modelSelection?.options,
    provider,
  });
  const speed = subagentSpeed(subagent.modelSelection);
  const working =
    props.status === "pending" || props.status === "running" || props.status === "waiting";
  const tone = working
    ? "working"
    : props.status === "failed"
      ? "failed"
      : props.status === "completed"
        ? "completed"
        : "stopped";
  const statusLabel = working
    ? "Researching…"
    : props.status === "failed"
      ? "Failed"
      : props.status === "completed"
        ? "Research done"
        : props.status === "idle"
          ? "Idle · resumable"
          : "Stopped";
  const detail = [
    subagent.model?.trim() ? modelLabel : null,
    speed ? SUBAGENT_SPEED_LABELS[speed] : null,
    !working && props.pages > 0 ? `${props.pages} ${props.pages === 1 ? "page" : "pages"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="min-h-[44px] flex-row items-center gap-[10px]">
      <View className="relative size-[28px] shrink-0 items-center justify-center rounded-full bg-subtle">
        <SymbolView name="binoculars" size={14} tintColorClassName="accent-icon-subtle" />
        <View className="absolute -right-px -bottom-px rounded-full border-2 border-subtle">
          <SubagentStatusDot tone={tone} placement="sheet" />
        </View>
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-w-0 flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
            {props.title}
          </Text>
          {props.elapsed}
        </View>
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          <Text className={SUBAGENT_TONE_TEXT_CLASS[tone]}>{statusLabel}</Text>
          {detail ? ` · ${detail}` : ""}
        </Text>
      </View>
      {props.canOpenThread ? (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      ) : null}
    </View>
  );
}

/** Shown site chips before the rest fold into "+N". */
const RESEARCH_SITE_CHIPS = 4;

/** What the research found, under its card: what it reads while working, then the report's opening and its sites. */
export function ResearchReport(props: {
  readonly working: boolean;
  readonly progress: string | null;
  readonly preview: string | null;
  readonly failure: string | null;
  readonly sites: ReadonlyArray<{ readonly url: string; readonly site: string }>;
  readonly onOpenSite: (url: string) => void;
}) {
  if (props.working) {
    return props.progress ? (
      <Text numberOfLines={1} className="mt-1.5 text-xs text-foreground-muted">
        {props.progress}
      </Text>
    ) : null;
  }
  if (props.failure) {
    return (
      <Text numberOfLines={2} className="mt-1.5 text-xs text-danger-foreground">
        {props.failure}
      </Text>
    );
  }
  const shown = props.sites.slice(0, RESEARCH_SITE_CHIPS);
  const hidden = props.sites.length - shown.length;
  if (!props.preview && shown.length === 0) return null;
  return (
    <View className="mt-1.5 gap-2">
      {props.preview ? (
        <Text numberOfLines={3} className="text-sm leading-5 text-foreground-muted">
          {props.preview}
        </Text>
      ) : null}
      {shown.length > 0 ? (
        <View accessibilityLabel="Sources" className="flex-row flex-wrap items-center gap-1.5">
          {shown.map((source) => (
            <Pressable
              key={source.site}
              accessibilityRole="link"
              accessibilityLabel={`Open ${source.site}`}
              onPress={() => props.onOpenSite(source.url)}
              hitSlop={6}
              className="min-h-8 max-w-[200px] flex-row items-center gap-1 rounded-full border border-border px-3 active:opacity-70"
            >
              <SymbolView name="globe" size={11} tintColorClassName="accent-icon-subtle" />
              <Text numberOfLines={1} className="text-xs text-foreground-muted">
                {source.site}
              </Text>
            </Pressable>
          ))}
          {hidden > 0 ? <Text className="text-xs text-foreground-muted">+{hidden}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
