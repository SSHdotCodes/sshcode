import { useContext, useEffect, useRef, useState } from "react";
import {
  createHarnessMascotPlayer,
  harnessMascotVariants,
  resolveHarnessMascotPosterFrame,
  type HarnessMascotId,
  type HarnessMascotState,
} from "@t3tools/shared/harnessMascots";
import { HarnessMascotTurnDuration } from "./HarnessMascot";
import { appHasAttention, subscribeAppAttention } from "../appAttention";
import { useTheme } from "../hooks/useTheme";

export function MascotSprite({
  id,
  state,
  size,
  still,
  pixelArt,
}: {
  readonly id: HarnessMascotId;
  readonly state: HarnessMascotState;
  readonly size: number;
  readonly still: boolean;
  readonly pixelArt: boolean;
}) {
  const completedTurnMs = useContext(HarnessMascotTurnDuration);
  // A flat pet has a second sheet in light ink for dark themes.
  const dark = useTheme().resolvedTheme === "dark";
  const host = useRef<HTMLSpanElement>(null);
  const elapsed = useRef(0);
  const [player] = useState(() => createHarnessMascotPlayer(id));
  const [frame, setFrame] = useState(() =>
    still ? resolveHarnessMascotPosterFrame(id, state) : player.frame(state, 0, completedTurnMs),
  );
  useEffect(() => {
    if (still) return;
    for (const animation of [
      ...harnessMascotVariants(id, state),
      ...harnessMascotVariants(id, "idle"),
    ]) {
      new Image().src = `/mascots/${(dark && animation.darkFile) || animation.file}`;
    }
  }, [id, state, still, dark]);
  useEffect(() => {
    const node = host.current;
    if (!node || still) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started: number | null = null;
    const pause = () => {
      clearTimeout(timer);
      if (started !== null) elapsed.current += performance.now() - started;
      started = null;
    };
    const tick = () => {
      const next = player.frame(
        state,
        elapsed.current + performance.now() - (started ?? 0),
        completedTurnMs,
      );
      setFrame(next);
      timer = setTimeout(tick, next.nextMs);
    };
    const sync = () => {
      pause();
      if (motion.matches) {
        setFrame(resolveHarnessMascotPosterFrame(id, state));
      } else if (visible && appHasAttention()) {
        started = performance.now();
        tick();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(node);
    const unsubscribeAttention = subscribeAppAttention(sync);
    motion.addEventListener("change", sync);
    return () => {
      pause();
      observer.disconnect();
      unsubscribeAttention();
      motion.removeEventListener("change", sync);
    };
  }, [id, state, still, player, completedTurnMs]);
  const displayed = still ? resolveHarnessMascotPosterFrame(id, state) : frame;
  const density = window.devicePixelRatio || 1;
  const spriteSize =
    pixelArt && displayed.pixelSize
      ? (Math.max(1, Math.floor((size * density) / displayed.pixelSize)) * displayed.pixelSize) /
        density
      : size;
  const inset = Math.round(((size - spriteSize) / 2) * density) / density;
  return (
    <span
      ref={host}
      aria-hidden="true"
      data-harness-mascot={id}
      data-mascot-state={displayed.state}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
        pointerEvents: "none",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          width: spriteSize,
          height: spriteSize,
          left: inset,
          top: inset,
          backgroundImage: `url(/mascots/${(dark && displayed.darkFile) || displayed.file})`,
          backgroundSize: `${displayed.columns * spriteSize}px ${displayed.rows * spriteSize}px`,
          backgroundPosition: `${-displayed.column * spriteSize}px ${-displayed.row * spriteSize}px`,
          backgroundRepeat: "no-repeat",
          imageRendering: pixelArt ? "pixelated" : "auto",
        }}
      />
    </span>
  );
}
