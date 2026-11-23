import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  cloneElement,
  createContext,
  isValidElement,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;
const DEFAULT_OPEN_DELAY_MS = 600;
const DEFAULT_CLOSE_DELAY_MS = 0;
const DEFAULT_GROUP_TIMEOUT_MS = 400;
// Base UI marks enabled triggers with this, and only this, to find nested ones.
// Lazy triggers carry it too, so either kind of parent yields to either kind of child.
const TOOLTIP_TRIGGER_ATTRIBUTE = "data-base-ui-tooltip-trigger";
const TOOLTIP_TRIGGER_SELECTOR = `[${TOOLTIP_TRIGGER_ATTRIBUTE}]`;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;
type TooltipScrollHoverRef = RefObject<{
  trigger: HTMLElement;
  actionsRef: TooltipActionsRef;
} | null>;

interface TooltipProviderGroup {
  activeClose: (() => void) | null;
  lastClosedAt: number;
}

interface TooltipProviderSettings {
  readonly delay: number | undefined;
  readonly closeDelay: number | undefined;
  readonly timeout: number | undefined;
  readonly group: TooltipProviderGroup;
}

const TooltipProviderContext = createContext<TooltipProviderSettings | null>(null);
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipScrollContext = createContext<TooltipScrollHoverRef | null>(null);

interface LazyOpenState {
  readonly anchor: HTMLElement;
  readonly reason: "hover" | "focus";
}

interface LazyTooltipController {
  readonly actionsRef: TooltipActionsRef;
  readonly onPointerEnter: (pointerType: string) => void;
  readonly onPointerDown: (pointerType: string, closeOnClick: boolean) => void;
  readonly onMouseEnter: (input: {
    readonly trigger: HTMLElement;
    readonly target: EventTarget | null;
    readonly disabled: boolean;
    readonly delay: number | undefined;
    readonly provider: TooltipProviderSettings | null;
    readonly hovered: TooltipScrollHoverRef | null;
  }) => void;
  readonly onMouseOver: (input: {
    readonly trigger: HTMLElement;
    readonly target: EventTarget | null;
    readonly disabled: boolean;
    readonly delay: number | undefined;
    readonly provider: TooltipProviderSettings | null;
    readonly hovered: TooltipScrollHoverRef | null;
  }) => void;
  readonly onMouseLeave: (input: {
    readonly closeDelay: number | undefined;
    readonly provider: TooltipProviderSettings | null;
    readonly disableHoverablePopup: boolean;
    readonly relatedTarget: EventTarget | null;
  }) => void;
  readonly onFocus: (input: {
    readonly trigger: HTMLElement;
    readonly target: EventTarget | null;
    readonly disabled: boolean;
    readonly provider: TooltipProviderSettings | null;
  }) => void;
  readonly onBlur: (relatedTarget: EventTarget | null) => void;
  readonly onClick: (closeOnClick: boolean) => void;
  readonly registerPopupElement: (node: HTMLElement | null) => void;
  readonly onPopupMouseEnter: () => void;
  readonly onPopupMouseLeave: (input: {
    readonly closeDelay: number | undefined;
    readonly provider: TooltipProviderSettings | null;
  }) => void;
  readonly close: (recordGroupClose?: boolean) => void;
  readonly dispose: () => void;
}

interface LazyTooltipContextValue {
  readonly controller: LazyTooltipController;
  readonly disabled: boolean;
  readonly disableHoverablePopup: boolean;
  readonly trackCursorAxis: TooltipPrimitive.Root.Props["trackCursorAxis"];
}

const LazyTooltipContext = createContext<LazyTooltipContextValue | null>(null);
const LazyTooltipOpenContext = createContext<LazyOpenState | null>(null);

const trackedDocuments = new WeakSet<Document>();
let hadKeyboardModality = false;

function ensureKeyboardModalityTracking(doc: Document | null | undefined) {
  if (!doc || trackedDocuments.has(doc)) return;
  trackedDocuments.add(doc);
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.altKey || event.ctrlKey) return;
      hadKeyboardModality = true;
    },
    { capture: true, passive: true },
  );
  const clearKeyboardModality = () => {
    hadKeyboardModality = false;
  };
  doc.addEventListener("pointerdown", clearKeyboardModality, { capture: true, passive: true });
  doc.addEventListener("mousedown", clearKeyboardModality, { capture: true, passive: true });
}

function matchesFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    // Environments without :focus-visible support fall back to keyboard modality tracking.
    return hadKeyboardModality;
  }
}

function isInsideNestedTrigger(target: EventTarget | null, currentTarget: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const closest = target.closest(TOOLTIP_TRIGGER_SELECTOR);
  return closest !== null && closest !== currentTarget;
}

function createLazyTooltipController(
  setOpenState: (next: LazyOpenState | null) => void,
): LazyTooltipController {
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let currentOpen: LazyOpenState | null = null;
  let currentProvider: TooltipProviderSettings | null = null;
  let currentHovered: TooltipScrollHoverRef | null = null;
  let popupElement: HTMLElement | null = null;
  let pointerType: string | undefined;
  let nestedHoverSuppressed = false;

  const clearTimers = () => {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const close = (recordGroupClose = false) => {
    clearTimers();
    const wasOpen = currentOpen !== null;
    currentOpen = null;
    if (currentHovered?.current?.actionsRef === actionsRef) {
      currentHovered.current = null;
    }
    if (currentProvider) {
      if (currentProvider.group.activeClose === closeNow) {
        currentProvider.group.activeClose = null;
      }
      if (recordGroupClose && wasOpen) {
        currentProvider.group.lastClosedAt = Date.now();
      }
    }
    if (wasOpen) {
      setOpenState(null);
    }
  };

  const closeNow = () => close(false);

  const actionsRef: TooltipActionsRef = {
    current: {
      unmount: closeNow,
      close: closeNow,
    },
  };

  const open = (
    anchor: HTMLElement,
    reason: "hover" | "focus",
    provider: TooltipProviderSettings | null,
  ) => {
    clearTimers();
    currentProvider = provider;
    if (provider) {
      if (provider.group.activeClose && provider.group.activeClose !== closeNow) {
        provider.group.activeClose();
      }
      provider.group.activeClose = closeNow;
    }
    currentOpen = { anchor, reason };
    setOpenState(currentOpen);
  };

  const startHover = (input: {
    readonly trigger: HTMLElement;
    readonly delay: number | undefined;
    readonly provider: TooltipProviderSettings | null;
    readonly hovered: TooltipScrollHoverRef | null;
  }) => {
    clearTimers();
    currentProvider = input.provider;
    currentHovered = input.hovered;
    if (input.hovered) {
      input.hovered.current = { trigger: input.trigger, actionsRef };
    }
    if (currentOpen !== null) return;
    const timeout = input.provider?.timeout ?? DEFAULT_GROUP_TIMEOUT_MS;
    const inInstantPhase =
      input.provider !== null &&
      ((input.provider.group.activeClose !== null &&
        input.provider.group.activeClose !== closeNow) ||
        Date.now() - input.provider.group.lastClosedAt < timeout);
    const effectiveDelay = inInstantPhase
      ? 0
      : (input.delay ?? input.provider?.delay ?? DEFAULT_OPEN_DELAY_MS);
    if (effectiveDelay <= 0) {
      open(input.trigger, "hover", input.provider);
      return;
    }
    openTimer = setTimeout(() => {
      openTimer = null;
      open(input.trigger, "hover", input.provider);
    }, effectiveDelay);
  };

  const cancelOrCloseOnClick = (closeOnClick: boolean) => {
    if (!closeOnClick) return;
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (currentOpen !== null) {
      close(false);
    }
  };

  return {
    actionsRef,
    onPointerEnter(nextPointerType) {
      pointerType = nextPointerType;
    },
    onPointerDown(nextPointerType, closeOnClick) {
      pointerType = nextPointerType;
      cancelOrCloseOnClick(closeOnClick);
    },
    onMouseEnter({ trigger, target, disabled, delay, provider, hovered }) {
      ensureKeyboardModalityTracking(trigger.ownerDocument);
      if (disabled || pointerType === "touch") return;
      if (isInsideNestedTrigger(target, trigger)) {
        nestedHoverSuppressed = true;
        return;
      }
      nestedHoverSuppressed = false;
      startHover({ trigger, delay, provider, hovered });
    },
    onMouseOver({ trigger, target, disabled, delay, provider, hovered }) {
      if (disabled) return;
      const nested = isInsideNestedTrigger(target, trigger);
      if (nested) {
        nestedHoverSuppressed = true;
        if (openTimer !== null) {
          clearTimeout(openTimer);
          openTimer = null;
        }
        if (currentOpen?.reason === "hover") {
          close(false);
        }
      } else if (nestedHoverSuppressed && pointerType !== "touch") {
        nestedHoverSuppressed = false;
        startHover({ trigger, delay, provider, hovered });
      }
    },
    onMouseLeave({ closeDelay, provider, disableHoverablePopup, relatedTarget }) {
      nestedHoverSuppressed = false;
      pointerType = undefined;
      if (openTimer !== null) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      if (currentOpen === null || currentOpen.reason !== "hover") {
        if (currentHovered?.current?.actionsRef === actionsRef) {
          currentHovered.current = null;
        }
        return;
      }
      if (
        !disableHoverablePopup &&
        popupElement !== null &&
        relatedTarget instanceof Node &&
        popupElement.contains(relatedTarget)
      ) {
        return;
      }
      const effectiveCloseDelay = closeDelay ?? provider?.closeDelay ?? DEFAULT_CLOSE_DELAY_MS;
      if (effectiveCloseDelay <= 0) {
        close(true);
        return;
      }
      if (closeTimer !== null) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = null;
        close(true);
      }, effectiveCloseDelay);
    },
    onFocus({ trigger, target, disabled, provider }) {
      ensureKeyboardModalityTracking(trigger.ownerDocument);
      if (disabled) return;
      if (isInsideNestedTrigger(target, trigger)) return;
      if (!matchesFocusVisible(trigger)) return;
      open(trigger, "focus", provider);
    },
    onBlur(relatedTarget) {
      if (
        popupElement !== null &&
        relatedTarget instanceof Node &&
        popupElement.contains(relatedTarget)
      ) {
        return;
      }
      if (currentOpen?.reason === "focus") {
        close(false);
      }
    },
    onClick: cancelOrCloseOnClick,
    registerPopupElement(node) {
      popupElement = node;
    },
    onPopupMouseEnter() {
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    },
    onPopupMouseLeave({ closeDelay, provider }) {
      if (currentOpen?.reason !== "hover") return;
      const effectiveCloseDelay = closeDelay ?? provider?.closeDelay ?? DEFAULT_CLOSE_DELAY_MS;
      if (effectiveCloseDelay <= 0) {
        close(true);
        return;
      }
      if (closeTimer !== null) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = null;
        close(true);
      }, effectiveCloseDelay);
    },
    close,
    dispose() {
      close(false);
      popupElement = null;
      pointerType = undefined;
      nestedHoverSuppressed = false;
    },
  };
}

function TooltipProvider({
  delay,
  closeDelay,
  timeout,
  children,
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  const [group] = useState<TooltipProviderGroup>(() => ({
    activeClose: null,
    lastClosedAt: Number.NEGATIVE_INFINITY,
  }));
  const settings = useMemo<TooltipProviderSettings>(
    () => ({ delay, closeDelay, timeout, group }),
    [delay, closeDelay, timeout, group],
  );
  return (
    <TooltipProviderContext value={settings}>
      <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay} timeout={timeout}>
        {children}
      </TooltipPrimitive.Provider>
    </TooltipProviderContext>
  );
}

/** Dismisses hovered descendants on real scroll events without rerendering the timeline. */
function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const hovered = useRef<{ trigger: HTMLElement; actionsRef: TooltipActionsRef } | null>(null);
  return (
    <TooltipScrollContext value={hovered}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          const tooltip = hovered.current;
          if (!tooltip || tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)) {
            return;
          }
          hovered.current = null;
          // Base UI also cancels delayed hover opens through this action.
          tooltip.actionsRef.current?.close();
        }}
      />
    </TooltipScrollContext>
  );
}

function EagerTooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const hovered = use(TooltipScrollContext);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  useEffect(
    () => () => {
      if (hovered?.current?.actionsRef === actionsRef) hovered.current = null;
    },
    [actionsRef, hovered],
  );

  // Inside a lazy tooltip's subtree, this tooltip's trigger and popup must not
  // pick up the outer lazy controller.
  return (
    <LazyTooltipContext value={null}>
      <LazyTooltipOpenContext value={null}>
        {hovered ? (
          <TooltipHoverContext value={actionsRef}>
            <TooltipPrimitive.Root
              {...props}
              actionsRef={actionsRef}
              onOpenChange={(open, details) => {
                props.onOpenChange?.(open, details);
                if (!open && !details.isCanceled && hovered.current?.actionsRef === actionsRef) {
                  hovered.current = null;
                }
              }}
            />
          </TooltipHoverContext>
        ) : (
          <TooltipPrimitive.Root {...props} />
        )}
      </LazyTooltipOpenContext>
    </LazyTooltipContext>
  );
}

function LazyTooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const [openState, setOpenState] = useState<LazyOpenState | null>(null);
  const [controller] = useState(() => createLazyTooltipController(setOpenState));
  const disabled = props.disabled === true;
  const disableHoverablePopup = props.disableHoverablePopup === true;
  const trackCursorAxis = props.trackCursorAxis;
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (disabled && openState !== null) {
      controller.close(false);
    }
  }, [controller, disabled, openState]);

  const contextValue = useMemo<LazyTooltipContextValue>(
    () => ({
      controller,
      disabled,
      disableHoverablePopup,
      trackCursorAxis,
    }),
    [controller, disabled, disableHoverablePopup, trackCursorAxis],
  );
  return (
    <LazyTooltipContext value={contextValue}>
      <LazyTooltipOpenContext value={openState}>
        {typeof props.children === "function"
          ? props.children({ payload: undefined })
          : props.children}
      </LazyTooltipOpenContext>
    </LazyTooltipContext>
  );
}

function canUseLazyTooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>): boolean {
  return (
    props.open === undefined &&
    props.defaultOpen === undefined &&
    props.actionsRef === undefined &&
    props.handle === undefined &&
    props.triggerId === undefined &&
    props.defaultTriggerId === undefined &&
    props.onOpenChange === undefined &&
    props.onOpenChangeComplete === undefined
  );
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  if (canUseLazyTooltip(props)) {
    return <LazyTooltip {...props} />;
  }
  return <EagerTooltip {...props} />;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): (() => void) | undefined {
  if (typeof ref === "function") {
    const cleanup = ref(value);
    return typeof cleanup === "function" ? cleanup : undefined;
  }
  if (ref != null) {
    (ref as { current: T | null }).current = value;
  }
  return undefined;
}

function composeRefs<T>(a: Ref<T> | undefined, b: Ref<T> | undefined): Ref<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  return (node: T | null) => {
    const cleanupA = assignRef(a, node);
    const cleanupB = assignRef(b, node);
    if (cleanupA || cleanupB) {
      return () => {
        cleanupA?.();
        cleanupB?.();
      };
    }
  };
}

function composeEventHandlers<E>(
  first: ((event: E) => void) | undefined,
  second: ((event: never) => void) | undefined,
  third: (event: E) => void,
): (event: E) => void {
  return (event: E) => {
    first?.(event);
    (second as ((event: E) => void) | undefined)?.(event);
    third(event);
  };
}

type TriggerRenderElementProps = Record<string, unknown> & {
  readonly ref?: Ref<HTMLElement> | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly onMouseEnter?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  readonly onMouseLeave?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  readonly onMouseOver?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  readonly onPointerEnter?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  readonly onPointerDown?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  readonly onFocus?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  readonly onBlur?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  readonly onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
};

function LazyTooltipTrigger({
  lazy,
  props,
}: {
  readonly lazy: LazyTooltipContextValue;
  readonly props: TooltipPrimitive.Trigger.Props;
}) {
  const hovered = use(TooltipScrollContext);
  const provider = use(TooltipProviderContext);

  const {
    render,
    delay,
    closeDelay,
    closeOnClick = true,
    // Base UI's trigger `disabled` turns off this trigger's tooltip; it never
    // disables the element. Pass `disabled` to the render element for that.
    disabled: disabledProp,
    handle: _handle,
    payload: _payload,
    className,
    style,
    children,
    ref,
    onMouseEnter,
    onMouseLeave,
    onMouseOver,
    onPointerEnter,
    onPointerDown,
    onFocus,
    onBlur,
    onClick,
    ...restProps
  } = props;

  const disabled = disabledProp ?? lazy.disabled;
  useEffect(() => {
    if (disabled) lazy.controller.close(false);
  }, [disabled, lazy.controller]);
  // A lazy root has one trigger, so its open state is this trigger's.
  const open = use(LazyTooltipOpenContext) !== null;
  const state = { open };

  const resolvedClassName = typeof className === "function" ? className(state) : className;
  const resolvedStyle = typeof style === "function" ? style(state) : style;

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    lazy.controller.onPointerEnter(event.pointerType);
  };
  const handleMouseEnter = (event: MouseEvent<HTMLElement>) => {
    lazy.controller.onMouseEnter({
      trigger: event.currentTarget,
      target: event.target,
      disabled,
      delay,
      provider,
      hovered,
    });
  };
  const handleMouseOver = (event: MouseEvent<HTMLElement>) => {
    lazy.controller.onMouseOver({
      trigger: event.currentTarget,
      target: event.target,
      disabled,
      delay,
      provider,
      hovered,
    });
  };
  const handleMouseLeave = (event: MouseEvent<HTMLElement>) => {
    lazy.controller.onMouseLeave({
      closeDelay,
      provider,
      disableHoverablePopup: lazy.disableHoverablePopup,
      relatedTarget: event.relatedTarget,
    });
  };
  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    lazy.controller.onFocus({
      trigger: event.currentTarget,
      target: event.target,
      disabled,
      provider,
    });
  };
  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    lazy.controller.onBlur(event.relatedTarget);
  };
  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    lazy.controller.onPointerDown(event.pointerType, closeOnClick);
  };
  const handleClick = () => {
    lazy.controller.onClick(closeOnClick);
  };

  if (isValidElement(render)) {
    const element = render as ReactElement<TriggerRenderElementProps>;
    const elementProps = element.props;
    const mergedProps: TriggerRenderElementProps = {
      ...restProps,
      ...elementProps,
      "data-slot": "tooltip-trigger",
      "data-popup-open": open ? "" : undefined,
      "data-trigger-disabled": disabled ? "" : undefined,
      [TOOLTIP_TRIGGER_ATTRIBUTE]: disabled ? undefined : "",
      ref: composeRefs(ref as Ref<HTMLElement> | undefined, elementProps.ref),
      className:
        resolvedClassName !== undefined || elementProps.className !== undefined
          ? cn(elementProps.className, resolvedClassName)
          : undefined,
      style:
        resolvedStyle !== undefined || elementProps.style !== undefined
          ? { ...elementProps.style, ...resolvedStyle }
          : undefined,
      onPointerEnter: composeEventHandlers(
        elementProps.onPointerEnter,
        onPointerEnter,
        handlePointerEnter,
      ),
      onMouseEnter: composeEventHandlers(elementProps.onMouseEnter, onMouseEnter, handleMouseEnter),
      onMouseOver: composeEventHandlers(elementProps.onMouseOver, onMouseOver, handleMouseOver),
      onMouseLeave: composeEventHandlers(elementProps.onMouseLeave, onMouseLeave, handleMouseLeave),
      onFocus: composeEventHandlers(elementProps.onFocus, onFocus, handleFocus),
      onBlur: composeEventHandlers(elementProps.onBlur, onBlur, handleBlur),
      onPointerDown: composeEventHandlers(
        elementProps.onPointerDown,
        onPointerDown,
        handlePointerDown,
      ),
      onClick: composeEventHandlers(elementProps.onClick, onClick, handleClick),
    };
    return children !== undefined
      ? cloneElement(element, mergedProps, children)
      : cloneElement(element, mergedProps);
  }

  const triggerProps = {
    ...restProps,
    "data-slot": "tooltip-trigger",
    "data-popup-open": open ? "" : undefined,
    "data-trigger-disabled": disabled ? "" : undefined,
    [TOOLTIP_TRIGGER_ATTRIBUTE]: disabled ? undefined : "",
    ref,
    className: resolvedClassName,
    style: resolvedStyle,
    onPointerEnter: composeEventHandlers(undefined, onPointerEnter, handlePointerEnter),
    onMouseEnter: composeEventHandlers(undefined, onMouseEnter, handleMouseEnter),
    onMouseOver: composeEventHandlers(undefined, onMouseOver, handleMouseOver),
    onMouseLeave: composeEventHandlers(undefined, onMouseLeave, handleMouseLeave),
    onFocus: composeEventHandlers(undefined, onFocus, handleFocus),
    onBlur: composeEventHandlers(undefined, onBlur, handleBlur),
    onPointerDown: composeEventHandlers(undefined, onPointerDown, handlePointerDown),
    onClick: composeEventHandlers(undefined, onClick, handleClick),
  };

  if (typeof render === "function") {
    return render(triggerProps as never, state);
  }

  return (
    <button
      {...(triggerProps as ComponentProps<"button">)}
      type={(restProps as ComponentProps<"button">).type ?? "button"}
    >
      {children}
    </button>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const lazy = use(LazyTooltipContext);
  if (lazy !== null) {
    return <LazyTooltipTrigger lazy={lazy} props={props} />;
  }
  const hovered = use(TooltipScrollContext);
  const actionsRef = use(TooltipHoverContext);
  if (!hovered || !actionsRef) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        hovered.current = { trigger: event.currentTarget, actionsRef };
      }}
    />
  );
}

/**
 * Treats the native titlebar strip as off-screen, so a tooltip that would open
 * under the window controls flips to its other side. Rendered inside the
 * portal so only open tooltips track the titlebar.
 */
const POSITIONER_CLASS =
  "pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none";
const STILL_POSITIONER_CLASS =
  "pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width)";

function TooltipPositioner(props: TooltipPrimitive.Positioner.Props) {
  const titlebarHeight = useNativeTitlebarHeight();
  return (
    <TooltipPrimitive.Positioner
      className={POSITIONER_CLASS}
      collisionPadding={{
        top: COLLISION_PADDING + titlebarHeight,
        right: COLLISION_PADDING,
        bottom: COLLISION_PADDING,
        left: COLLISION_PADDING,
      }}
      data-slot="tooltip-positioner"
      {...props}
    />
  );
}

type TooltipPopupProps = TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  /** `code` renders monospace content that breaks anywhere, for paths and commands. */
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  /** Shows and hides in place: no fade, scale, slide or resize, for large cards. */
  still?: boolean;
};

function TooltipPopupContent({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  still = false,
  children,
  ...props
}: TooltipPopupProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner
        align={align}
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        {...(still ? { className: STILL_POSITIONER_CLASS } : {})}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            // One wrap width for prose; code dumps get more room and break anywhere.
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal leading-snug",
            still && "transition-none data-ending-style:scale-100 data-starting-style:scale-100",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPositioner>
    </TooltipPrimitive.Portal>
  );
}

function LazyTooltipPopupOpen({
  lazy,
  openState,
  popupProps,
}: {
  readonly lazy: LazyTooltipContextValue;
  readonly openState: LazyOpenState;
  readonly popupProps: TooltipPopupProps;
}) {
  const provider = use(TooltipProviderContext);
  useEffect(() => {
    const doc = openState.anchor.ownerDocument;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        lazy.controller.close(false);
      }
    };
    doc.addEventListener("keydown", onKeyDown, true);
    return () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      lazy.controller.registerPopupElement(null);
    };
  }, [lazy.controller, openState.anchor]);

  const { anchor, ref, onMouseEnter, onMouseLeave, ...rest } = popupProps;
  const popupRef = composeRefs(
    ref as Ref<HTMLDivElement> | undefined,
    (node: HTMLDivElement | null) => lazy.controller.registerPopupElement(node),
  );

  return (
    <TooltipPrimitive.Root
      open
      disableHoverablePopup={lazy.disableHoverablePopup}
      trackCursorAxis={lazy.trackCursorAxis}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) lazy.controller.close(false);
      }}
    >
      <TooltipPopupContent
        {...rest}
        anchor={anchor ?? openState.anchor}
        ref={popupRef}
        onMouseEnter={composeEventHandlers(undefined, onMouseEnter, () => {
          if (!lazy.disableHoverablePopup) lazy.controller.onPopupMouseEnter();
        })}
        onMouseLeave={composeEventHandlers(undefined, onMouseLeave, () => {
          if (!lazy.disableHoverablePopup) {
            lazy.controller.onPopupMouseLeave({ closeDelay: undefined, provider });
          }
        })}
      />
    </TooltipPrimitive.Root>
  );
}

function TooltipPopup(props: TooltipPopupProps) {
  const lazy = use(LazyTooltipContext);
  if (lazy !== null) {
    const openState = use(LazyTooltipOpenContext);
    if (openState === null) return null;
    return <LazyTooltipPopupOpen lazy={lazy} openState={openState} popupProps={props} />;
  }
  return <TooltipPopupContent {...props} />;
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea };
