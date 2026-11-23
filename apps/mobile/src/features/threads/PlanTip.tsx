import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { betterPlanTip, type PlanTip as PlanTipData } from "@t3tools/shared/planTip";
import {
  nextPlanTipDisplay,
  planTipCopy,
  planTipKey,
  runningChatAccountTip,
  type PlanTipDisplay,
} from "@t3tools/client-runtime/plan-tip";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useCoarseNow } from "../../lib/useCoarseNow";

const shownPairs = new Set<string>();

/** In-memory, once per chat/pair, including composer unmounts. No selection side effects. */
function usePlanTip(chatKey: string, tip: PlanTipData | null, blocked: boolean) {
  const key = tip === null ? null : planTipKey(chatKey, tip);
  const [active, setActive] = useState<PlanTipDisplay | null>(null);
  useEffect(() => {
    const next = nextPlanTipDisplay(key, active, blocked, shownPairs, Date.now());
    if (next === active) return;
    if (next !== null) shownPairs.add(next.key);
    setActive(next);
  }, [key, active, blocked]);
  const visible = key !== null && key === active?.key && !blocked;
  useEffect(() => {
    if (!visible || active === null) return;
    const timer = setTimeout(() => setActive(null), Math.max(0, active.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [active, visible]);
  return { visible, dismiss: () => setActive(null) };
}

export function PlanTip(props: {
  chatKey: string;
  providers: ReadonlyArray<ServerProvider>;
  selection: { instanceId: string; model: string };
  blocked: boolean;
  /**
   * Set for a chat that already runs. Its tip appears only when the chat's account is nearly
   * out and another has room, stays until closed, and closing is remembered for the chat.
   */
  running?:
    | {
        readonly dismissed: boolean;
        readonly onDismiss: () => void;
        /** Leaves out accounts this chat could not run its model on. */
        readonly accepts?: (provider: ServerProvider, model: string) => boolean;
      }
    | undefined;
  onSelect: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const running = props.running;
  const now = useCoarseNow();
  const tip = useMemo(
    () => (running ? null : betterPlanTip(props.providers, props.selection, { now })),
    [now, props.providers, props.selection, running],
  );
  const accepts = running?.accepts;
  const runningTip = useMemo(
    () =>
      running && !running.dismissed
        ? runningChatAccountTip(
            props.providers,
            props.selection,
            now,
            accepts ? (provider) => accepts(provider, props.selection.model) : undefined,
          )
        : null,
    [accepts, now, props.providers, props.selection, running],
  );
  const { visible, dismiss } = usePlanTip(props.chatKey, tip, props.blocked);
  const copy =
    runningTip !== null
      ? props.blocked
        ? null
        : runningTip
      : visible && tip
        ? {
            ...planTipCopy(props.providers, props.selection.model, tip),
            toInstanceId: tip.toInstanceId,
          }
        : null;
  if (copy === null) return null;
  const close = () => {
    if (runningTip !== null) running?.onDismiss();
    else dismiss();
  };
  return (
    <View className="flex-row items-center gap-2 px-2 pb-2">
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted">{copy.message}</Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => {
          // Taking a running chat's tip is not closing it: the same chat may later be
          // better off back on this account.
          if (runningTip === null) dismiss();
          props.onSelect(ProviderInstanceId.make(copy.toInstanceId), props.selection.model);
        }}
        className="min-h-11 justify-center px-2 py-2 active:opacity-70"
      >
        <Text className="font-t3-medium text-xs text-primary">Use {copy.to}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss tip"
        hitSlop={12}
        onPress={close}
        className="p-1 active:opacity-60"
      >
        <SymbolView
          name="xmark"
          size={14}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
