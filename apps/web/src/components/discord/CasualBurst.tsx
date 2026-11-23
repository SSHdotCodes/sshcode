import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CasualVoiceDisplay } from "@t3tools/contracts";
import {
  casualHiddenLabel,
  planCasualReveal,
  casualDisplayParts,
} from "@t3tools/shared/casualVoice";

export function useCasualVisibility(active = true) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReduced] = useState(false);
  useEffect(() => {
    if (!active) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let intersects = false;
    const update = () => {
      setVisible(intersects && document.visibilityState === "visible");
      setReduced(motion.matches);
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersects = entry?.isIntersecting ?? false;
      update();
    });
    if (element) observer.observe(element);
    document.addEventListener("visibilitychange", update);
    motion.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      motion.removeEventListener("change", update);
    };
  }, [element, active]);
  return { ref: setElement, visible, reducedMotion };
}
function HiddenProse({ original }: { original: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-casual-hidden>
      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {casualHiddenLabel(original)}
      </button>
      {expanded ? (
        <div className="whitespace-pre-wrap text-sm text-muted-foreground">{original}</div>
      ) : null}
    </div>
  );
}
export function CasualBurst({
  display,
  live,
  visible,
  reducedMotion,
  agent,
  render,
}: {
  display: CasualVoiceDisplay;
  live: boolean;
  visible: boolean;
  reducedMotion: boolean;
  agent: string;
  render: (text: string) => ReactNode;
}) {
  const parts = useMemo(() => casualDisplayParts(display), [display]);
  const bubbles = useMemo(() => parts.filter((part) => part.kind === "say"), [parts]);
  const [revealed, setRevealed] = useState(1);
  useEffect(() => {
    const plan = planCasualReveal(
      bubbles.map((part) => part.text.length),
      { live, visible, reducedMotion },
    );
    if (!live || !visible || reducedMotion) {
      queueMicrotask(() => setRevealed(bubbles.length));
      return;
    }
    const timers = plan.map((at, index) =>
      setTimeout(() => setRevealed((prior) => Math.max(prior, index + 1)), at),
    );
    return () => timers.forEach(clearTimeout);
  }, [bubbles, live, visible, reducedMotion]);
  const count = !live || !visible || reducedMotion ? bubbles.length : revealed;
  return (
    <div data-casual-display-only>
      {parts.map((part) =>
        part.kind === "hide" ? (
          <HiddenProse key={part.id} original={part.original} />
        ) : part.kind === "say" && part.ordinal < count ? (
          <div
            key={part.id}
            data-casual-bubble
            className="mb-2"
            role="group"
            aria-label={`${agent} message`}
          >
            {render(part.text)}
          </div>
        ) : null,
      )}
      {count < bubbles.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          {agent} is typing…
        </p>
      ) : null}
    </div>
  );
}
