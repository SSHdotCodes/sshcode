import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { memo, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { XIcon } from "lucide-react";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { betterPlanTip, type PlanTip as PlanTipData } from "@t3tools/shared/planTip";
import {
  nextPlanTipDisplay,
  planTipCopy,
  planTipKey,
  runningChatAccountTip,
  type PlanTipDisplay,
} from "@t3tools/client-runtime/plan-tip";

import { Button, InlineButton } from "../ui/button";
import { useComposerMenuProps } from "./composerEventScope";
import { observeResize } from "../../lib/observeResize";
import { useNowMinute } from "../../hooks/useNowMinute";

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

export const PlanTip = memo(function PlanTip(props: {
  chatKey: string;
  providers: ReadonlyArray<ServerProvider>;
  selection: { instanceId: string; model: string };
  anchor: HTMLButtonElement | null;
  surfaceRef: RefObject<HTMLElement | null>;
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
  const now = Date.parse(`${useNowMinute()}:00Z`);
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
  const [sideOffset, setSideOffset] = useState<number | null>(null);
  const floatingLayerProps = useComposerMenuProps();

  // Keep the popup aligned with the picker, above the whole composer rather than over its editor.
  useLayoutEffect(() => {
    const anchor = props.anchor;
    const surface = props.surfaceRef.current;
    if (!anchor || !surface) return;
    const measure = () =>
      setSideOffset(
        Math.max(0, anchor.getBoundingClientRect().top - surface.getBoundingClientRect().top) + 6,
      );
    measure();
    return observeResize([surface, anchor], measure);
  }, [props.anchor, props.surfaceRef]);

  const { visible, dismiss } = usePlanTip(
    props.chatKey,
    tip,
    props.blocked || props.anchor === null || sideOffset === null,
  );
  const blocked = props.blocked || props.anchor === null || sideOffset === null;
  const copy =
    runningTip !== null
      ? blocked
        ? null
        : runningTip
      : visible && tip
        ? {
            ...planTipCopy(props.providers, props.selection.model, tip),
            toInstanceId: tip.toInstanceId,
          }
        : null;
  if (copy === null || !props.anchor || sideOffset === null) return null;
  const close = () => {
    if (runningTip !== null) running?.onDismiss();
    else dismiss();
  };
  return (
    <PopoverPrimitive.Root open modal={false}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={props.anchor}
          side="top"
          align="start"
          sideOffset={sideOffset}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="z-50 max-w-[calc(100vw-16px)]"
        >
          <PopoverPrimitive.Popup
            {...floatingLayerProps}
            aria-label="Plan suggestion"
            initialFocus={false}
            finalFocus={false}
            className="flex items-center gap-2 rounded-md border bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-md/5 outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag]"
          >
            <span>{copy.message}</span>
            <InlineButton
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                // Taking a running chat's tip is not closing it: the same chat may later
                // be better off back on this account.
                if (runningTip === null) dismiss();
                props.onSelect(ProviderInstanceId.make(copy.toInstanceId), props.selection.model);
              }}
            >
              Use {copy.to}
            </InlineButton>
            <Button
              variant="ghost-muted"
              size="icon-tiny"
              aria-label="Dismiss tip"
              onPointerDown={(event) => event.preventDefault()}
              onClick={close}
            >
              <XIcon />
            </Button>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
});
