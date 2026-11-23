import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveHandoffEndpoints,
  resolveModelSwitchChange,
  type HandoffEndpoints,
} from "@t3tools/client-runtime/handoff";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2HandoffBriefSource,
  OrchestrationV2ModelSwitch,
  OrchestrationV2ProjectedTurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { Alert, Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { DIVIDER_ARRIVAL_MS, ThreadContextDivider } from "./thread-context-divider";

function handoffEndpointsAtom(
  environmentId: EnvironmentId,
  { item, sourceThreadId }: OrchestrationV2ProjectedTurnItem,
) {
  let previous: ReturnType<typeof resolveHandoffEndpoints> | null = null;
  const ref = scopeThreadRef(environmentId, sourceThreadId);
  return Atom.make((get) => {
    if (item.type !== "handoff") return null;
    const projection = get(environmentThreadDetails.threadAtom(ref))?.projection;
    const next = resolveHandoffEndpoints(item, projection?.runs ?? []);
    // Run activity changes frequently; only endpoint changes affect this row.
    if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
    return previous;
  });
}

export function ThreadHandoffRow(props: {
  environmentId: EnvironmentId;
  projectedItem: OrchestrationV2ProjectedTurnItem;
  iconColor: ColorValue;
}) {
  const { item } = props.projectedItem;
  const endpointsAtom = useMemo(
    () => handoffEndpointsAtom(props.environmentId, props.projectedItem),
    [props.environmentId, props.projectedItem],
  );
  const endpoints = useAtomValue(endpointsAtom);
  if (item.type !== "handoff" || endpoints === null) return null;
  const color = item.status === "failed" ? "#e11d48" : props.iconColor;
  return (
    <ThreadHandoffDivider
      environmentId={props.environmentId}
      endpoints={endpoints}
      iconColor={color}
      label="Context handoff"
      brief={item.brief}
      failed={item.status === "failed"}
      arriving={
        Date.now() - DateTime.toEpochMillis(item.startedAt ?? item.updatedAt) < DIVIDER_ARRIVAL_MS
      }
    />
  );
}

export function ThreadHandoffDivider(props: {
  environmentId: EnvironmentId;
  endpoints: HandoffEndpoints;
  iconColor: ColorValue;
  label: string;
  /** Who wrote the brief that came along, once delivered. */
  brief?: OrchestrationV2HandoffBriefSource | undefined;
  /** A pending handoff names who will write its brief (Settings › Text generation on the Mac). */
  pending?: boolean;
  failed?: boolean;
  arriving?: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const { endpoints } = props;
  const providers = config?.providers ?? [];
  const leaving = endpoints.from[endpoints.from.length - 1];
  const settings = config?.settings;
  const writer =
    props.pending !== true || settings === undefined || leaving === undefined
      ? null
      : !settings.handoffBriefEnabled
        ? "no brief"
        : `brief by ${
            settings.handoffBriefModelSelection === null
              ? handoffModelLabel(providers, leaving.instanceId, leaving.model)
              : handoffModelLabel(
                  providers,
                  settings.handoffBriefModelSelection.instanceId,
                  settings.handoffBriefModelSelection.model,
                )
          }`;
  return (
    <ThreadContextDivider
      label={props.label}
      icon="arrow.left.arrow.right"
      iconColor={props.iconColor}
      failed={props.failed}
      arriving={props.arriving}
    >
      <View className="flex-row flex-wrap items-center justify-center gap-1.5">
        {endpoints.from.map((endpoint, index) => (
          <View
            key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
            className="max-w-full flex-row items-center"
          >
            <HandoffEndpoint {...endpoint} providers={config?.providers ?? []} />
            {index < endpoints.from.length - 1 ? (
              <Text accessible={false} className="text-xs text-foreground-muted">
                ,
              </Text>
            ) : null}
          </View>
        ))}
        {endpoints.from.length > 0 ? (
          <SymbolView name="arrow.right" size={12} tintColor={props.iconColor} />
        ) : null}
        <HandoffEndpoint {...endpoints.to} providers={providers} />
        {writer === null ? null : <Text className="text-xs text-foreground-muted">{writer}</Text>}
        {props.brief === undefined ? null : (
          <Text className="text-xs text-foreground-muted">
            with a brief from{" "}
            {handoffModelLabel(providers, props.brief.providerInstanceId, props.brief.model)}
          </Text>
        )}
      </View>
    </ThreadContextDivider>
  );
}

function handoffModelLabel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  slug: string | undefined,
) {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === slug);
  return (
    model?.shortName ??
    model?.name ??
    slug ??
    (provider ? resolveProviderInstanceDisplayName(provider) : instanceId)
  );
}

function HandoffEndpoint(props: {
  instanceId: ProviderInstanceId;
  model?: string | undefined;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const provider = props.providers.find((candidate) => candidate.instanceId === props.instanceId);
  const label = handoffModelLabel(props.providers, props.instanceId, props.model);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Show provider account"
      className="min-h-6 max-w-full flex-row items-center justify-center gap-1"
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() =>
        Alert.alert(
          label,
          provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId,
        )
      }
    >
      <ProviderIcon
        provider={provider?.driver ?? props.instanceId}
        iconUrl={provider?.iconUrl}
        size={12}
      />
      <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}

/** A same-harness model or effort change. Shows only what changed. */
export function ThreadModelSwitchDivider(props: {
  environmentId: EnvironmentId;
  modelSwitch: OrchestrationV2ModelSwitch;
  iconColor: ColorValue;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const change = resolveModelSwitchChange(props.modelSwitch, providers);
  if (change === null) return null;
  const describe = (selection: ModelSelection, effort: string | undefined) => {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === selection.model);
    const modelName = model?.name ?? selection.model;
    return [change.modelChanged ? modelName : null, effort].filter(Boolean).join(" ");
  };
  const { from, to } = props.modelSwitch;
  return (
    <ThreadContextDivider
      label={`${describe(from, change.effort?.from)} → ${describe(to, change.effort?.to)}`}
      iconColor={props.iconColor}
    />
  );
}
