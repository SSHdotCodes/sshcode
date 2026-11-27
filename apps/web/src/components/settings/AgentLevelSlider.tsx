import { useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";

/**
 * Settings > Agents' stepped slider: one stop per level, the level names under their stops
 * (clickable), and a small dot above Default's stop so today's behavior is easy to find.
 * Arrow keys move one stop; dragging snaps to the nearest stop and saves on release.
 * Locked, it stays readable but doesn't move; a click or key press calls `onLockedPress`.
 */
export function AgentLevelSlider(props: {
  readonly label: string;
  readonly options: ReadonlyArray<string>;
  readonly index: number;
  readonly defaultIndex: number;
  readonly onChange: (index: number) => void;
  readonly locked?: boolean;
  readonly onLockedPress?: () => void;
}) {
  const { options, index, defaultIndex, locked = false } = props;
  const last = options.length - 1;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const shown = dragIndex ?? index;
  const at = (stop: number) => `${(stop / last) * 100}%`;
  // Stops sit at the centers of equal columns, so each name centers under its stop.
  const inset = `${50 / options.length}%`;
  const commit = (next: number) => {
    const stop = Math.min(last, Math.max(0, next));
    if (stop !== index) props.onChange(stop);
  };
  const stopAt = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = rect.width / (2 * options.length);
    const fraction = (event.clientX - rect.left - edge) / Math.max(1, rect.width - 2 * edge);
    return Math.min(last, Math.max(0, Math.round(fraction * last)));
  };

  return (
    <div className="select-none">
      <div
        role="slider"
        tabIndex={0}
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={options[shown]}
        aria-disabled={locked || undefined}
        className={cn(
          "group/level-slider relative h-8 touch-none rounded-md outline-none",
          locked ? "cursor-default" : "cursor-pointer",
        )}
        onKeyDown={(event) => {
          if (locked) {
            if (
              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              props.onLockedPress?.();
            }
            return;
          }
          const step =
            event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? -1
              : event.key === "ArrowRight" || event.key === "ArrowUp"
                ? 1
                : null;
          if (step !== null) commit(index + step);
          else if (event.key === "Home") commit(0);
          else if (event.key === "End") commit(last);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (locked) {
            props.onLockedPress?.();
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          setDragIndex(stopAt(event));
        }}
        onPointerMove={(event) => {
          if (dragIndex !== null) setDragIndex(stopAt(event));
        }}
        onPointerUp={(event) => {
          if (dragIndex === null) return;
          setDragIndex(null);
          commit(stopAt(event));
        }}
        onPointerCancel={() => setDragIndex(null)}
      >
        <div
          className={cn(
            "absolute inset-y-0 transition-opacity duration-150",
            locked && "opacity-50",
          )}
          style={{ left: inset, right: inset }}
        >
          {defaultIndex >= 0 ? (
            <span
              aria-hidden
              className="absolute top-1 size-1 -translate-x-1/2 rounded-full bg-muted-foreground/60"
              style={{ left: at(defaultIndex) }}
            />
          ) : null}
          <span
            aria-hidden
            className="absolute inset-x-0 top-5 h-1 -translate-y-1/2 rounded-full bg-input"
          />
          <span
            aria-hidden
            className="absolute left-0 top-5 h-1 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-150 ease-out motion-reduce:transition-none"
            style={{ width: at(shown) }}
          />
          {options.map((option, stop) => (
            <span
              key={option}
              aria-hidden
              className={cn(
                "absolute top-5 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                stop <= shown ? "bg-primary" : "bg-muted-foreground/45",
              )}
              style={{ left: at(stop) }}
            />
          ))}
          <span
            aria-hidden
            className="absolute top-5 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-white shadow-sm transition-[left] duration-150 ease-out group-focus-visible/level-slider:ring-2 group-focus-visible/level-slider:ring-inset group-focus-visible/level-slider:ring-ring motion-reduce:transition-none"
            style={{ left: at(shown) }}
          />
        </div>
      </div>
      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option, stop) => (
          <button
            key={option}
            type="button"
            // The slider takes the keyboard; the names are for the pointer.
            tabIndex={-1}
            className={cn(
              "justify-self-center rounded-sm px-1 text-xs transition-colors duration-120",
              stop === shown
                ? "font-medium text-foreground"
                : locked
                  ? "text-muted-foreground/70"
                  : "text-muted-foreground hover:text-foreground",
              locked ? "cursor-default" : "cursor-pointer",
            )}
            onClick={() => (locked ? props.onLockedPress?.() : commit(stop))}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
