import {
  BOT_AVATAR_GEOMETRY as GEOMETRY,
  BOT_AVATAR_MOTION as MOTION,
  BOT_NEEDS_YOU_COLOR,
  botPalette,
} from "@t3tools/client-runtime/state/bots";
import { useEffect, useId, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useElementState } from "../../hooks/useElementState";
import { cn } from "../../lib/utils";

export type BotAvatarState = "idle" | "working" | "needsYou" | "paused";

const VIEW = 100;
const EYE_W = GEOMETRY.eyeWidth * VIEW;
const EYE_H = GEOMETRY.eyeHeight * VIEW;
const EYE_Y = GEOMETRY.eyeCenterY * VIEW - EYE_H / 2;
const EYE_R = GEOMETRY.eyeRadius * VIEW;
const DOT = GEOMETRY.needsYouDot;
/** One glance position per step of a working cycle: left, center, right, center. */
const GLANCE_STEPS = [-1, 0, 1, 0] as const;
const EYE_TRANSITION =
  "transform 120ms ease-out, translate 420ms cubic-bezier(0.4, 0, 0.2, 1)" as const;

/**
 * Whether the avatar may move now: motion allowed, the page visible and the avatar on screen.
 * Timers stop otherwise, so a hidden window or a scrolled-away row costs nothing.
 */
function useAvatarAwake(element: Element | null, wanted: boolean, reduceMotion: boolean): boolean {
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [onScreen, setOnScreen] = useState(true);
  const active = wanted && !reduceMotion;
  useEffect(() => {
    if (!active) return;
    const update = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [active]);
  useEffect(() => {
    if (!active || element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, element]);
  return active && pageVisible && onScreen;
}

/** A blink every ~6 s: a short scale transition switched on and off by a timer. */
function useBlink(awake: boolean): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (!awake) return;
    let timer: number;
    const schedule = () => {
      // A little jitter so several avatars never blink in step.
      timer = window.setTimeout(
        () => {
          setBlinking(true);
          timer = window.setTimeout(() => {
            setBlinking(false);
            schedule();
          }, MOTION.blinkMs);
        },
        MOTION.blinkEveryMs * (0.75 + Math.random() * 0.5),
      );
    };
    schedule();
    return () => {
      window.clearTimeout(timer);
      setBlinking(false);
    };
  }, [awake]);
  return blinking;
}

/** While working, the eyes step left, center, right, center: one short move per step. */
function useGlance(awake: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!awake) return;
    const timer = window.setInterval(
      () => setStep((current) => (current + 1) % GLANCE_STEPS.length),
      MOTION.glanceMs / GLANCE_STEPS.length,
    );
    return () => {
      window.clearInterval(timer);
      setStep(0);
    };
  }, [awake]);
  return awake ? GLANCE_STEPS[step]! : 0;
}

/**
 * A bot's face: a soft gradient circle in its color, two white rounded eyes and a faint
 * highlight, no mouth. Idle blinks, working glances side to side, needs you looks up with an
 * amber dot, paused rests dimmed. Motion is short transitions switched by timers, never a
 * running animation, and stops with reduced motion, a hidden window or an offscreen avatar.
 */
export function BotAvatar({
  color,
  size,
  state = "idle",
  animate = true,
  className,
  ringClassName = "stroke-background",
}: {
  readonly color: string;
  /** Diameter in pixels. */
  readonly size: number;
  readonly state?: BotAvatarState;
  /** Off for previews and lists that should hold still. */
  readonly animate?: boolean;
  readonly className?: string;
  /** The dot's ring, matching the surface the avatar sits on. */
  readonly ringClassName?: string;
}) {
  const gradientId = useId();
  const palette = botPalette(color);
  const [element, setElement] = useElementState<SVGSVGElement>();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const awake = useAvatarAwake(element, animate && state !== "paused", reduceMotion);
  const blinking = useBlink(awake);
  const glance = useGlance(awake && state === "working");
  const dx = glance * GEOMETRY.glanceX * VIEW;
  const dy = state === "needsYou" ? GEOMETRY.lookUpY * VIEW : 0;
  const highlight = GEOMETRY.highlight;
  return (
    <svg
      ref={setElement}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      width={size}
      height={size}
      aria-hidden
      className={cn("shrink-0 overflow-visible", state === "paused" && "opacity-55", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={palette.top} />
          <stop offset="1" stopColor={palette.fill} />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill={`url(#${gradientId})`} />
      <ellipse
        cx={highlight.cx * VIEW}
        cy={highlight.cy * VIEW}
        rx={highlight.rx * VIEW}
        ry={highlight.ry * VIEW}
        fill="currentColor"
        className="text-white"
        opacity={highlight.opacity}
      />
      <g
        style={{
          translate: `${dx}px ${dy}px`,
          transform: `scaleY(${blinking ? MOTION.blinkScaleY : state === "paused" ? 0.45 : 1})`,
          transformBox: "fill-box",
          transformOrigin: "center",
          transition: animate && !reduceMotion ? EYE_TRANSITION : undefined,
        }}
        fill="currentColor"
        className="text-white"
      >
        {GEOMETRY.eyeCentersX.map((center) => (
          <rect
            key={center}
            x={center * VIEW - EYE_W / 2}
            y={EYE_Y}
            width={EYE_W}
            height={EYE_H}
            rx={EYE_R}
          />
        ))}
      </g>
      {state === "needsYou" ? (
        <circle
          cx={DOT.cx * VIEW}
          cy={DOT.cy * VIEW}
          r={(DOT.size * VIEW) / 2}
          fill={BOT_NEEDS_YOU_COLOR}
          strokeWidth={VIEW * 0.06}
          className={ringClassName}
        />
      ) : null}
    </svg>
  );
}
