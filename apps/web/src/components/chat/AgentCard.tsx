import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import { type EnvironmentId, type OrchestrationMessageContext, ThreadId } from "@t3tools/contracts";
import {
  buildCardReplyContext,
  cardChartBar,
  cardChartRange,
  cardChartSeriesColors,
  type CardAction,
  type CardBlock,
  type CardChart,
  type CardIcon,
  type CardImage,
  type CardInput,
  type CardInputValues,
  type CardLockedState,
  type CardProgress,
  type CardRowItem,
  type CardRowStatus,
  type CardSpec,
  type CardStatItem,
  type CardTone,
  formatCardInputsReply,
  formatChartNumber,
  formatSliderValue,
  initialCardInputValues,
  layoutChartXLabels,
  snapSliderValue,
  statDeltaSentiment,
} from "@t3tools/shared/cards";
import { Link } from "@tanstack/react-router";
import {
  BarChart3Icon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  ListIcon,
  MessageCircleIcon,
  SparklesIcon,
} from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAssetUrlState } from "../../assets/assetUrls";
import { openQuestThread } from "../../questBridge";
import { useLinkedThreadShell } from "../../state/entities";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Switch } from "../ui/switch";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

/** Outline bot face glyph: circle stroke + two filled rounded-rect eyes, no mouth. */
export function BotFaceGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      className={cn("size-[18px] shrink-0", className)}
    >
      <circle cx="9" cy="9" r="7.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="5.45" y="6.5" width="2.2" height="3.5" rx="1.1" fill="currentColor" />
      <rect x="10.35" y="6.5" width="2.2" height="3.5" rx="1.1" fill="currentColor" />
    </svg>
  );
}

/** Tiny glyph shown on user bubbles sent from an interactive card. */
export function CardReplyGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={cn("size-3 shrink-0", className)}
    >
      <rect
        x="1.5"
        y="2.25"
        width="11"
        height="9.5"
        rx="2.25"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.25 5.5H9.75M4.25 8.25H7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

const TONE_BAR_CLASS: Record<CardTone, string | null> = {
  neutral: null,
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
};

const TONE_ICON_CLASS: Record<CardTone, string> = {
  neutral: "text-muted-foreground",
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
};

function CardHeaderIcon({ icon, tone }: { readonly icon: CardIcon; readonly tone: CardTone }) {
  const cls = cn("size-[18px] shrink-0", TONE_ICON_CLASS[tone]);
  switch (icon) {
    case "chat":
      return <MessageCircleIcon className={cls} aria-hidden />;
    case "check":
      return <CheckCircle2Icon className={cls} aria-hidden />;
    case "alert":
      return <CircleAlertIcon className={cls} aria-hidden />;
    case "clock":
      return <ClockIcon className={cls} aria-hidden />;
    case "chart":
      return <BarChart3Icon className={cls} aria-hidden />;
    case "list":
      return <ListIcon className={cls} aria-hidden />;
    case "spark":
      return <SparklesIcon className={cls} aria-hidden />;
    case "bot":
      return <BotFaceGlyph className={cls} />;
  }
}

function RowStatusIndicator({ status }: { readonly status: CardRowStatus }) {
  switch (status) {
    case "running":
      return (
        <span
          aria-label="Running"
          className="inline-flex size-4 shrink-0 items-center justify-center"
        >
          <span className="size-2 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
        </span>
      );
    case "done":
      return (
        <span
          aria-label="Done"
          className="inline-flex size-4 shrink-0 items-center justify-center text-success"
        >
          <CheckIcon className="size-3.5" strokeWidth={2.5} aria-hidden />
        </span>
      );
    case "failed":
      return (
        <span
          aria-label="Failed"
          className="inline-flex size-4 shrink-0 items-center justify-center"
        >
          <span className="size-2 rounded-full bg-destructive" />
        </span>
      );
    case "waiting":
      return (
        <span
          aria-label="Waiting"
          className="inline-flex size-4 shrink-0 items-center justify-center"
        >
          <span className="size-2 rounded-full bg-warning" />
        </span>
      );
    case "idle":
      return (
        <span aria-label="Idle" className="inline-flex size-4 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full bg-muted-foreground/45" />
        </span>
      );
  }
}

function CardRow({
  row,
  environmentId,
}: {
  readonly row: CardRowItem;
  readonly environmentId: EnvironmentId;
}) {
  const linked = useLinkedThreadShell(
    row.chat ? scopeThreadRef(environmentId, ThreadId.make(row.chat)) : null,
  );
  const canOpen = linked !== null && linked.deletedAt === null;

  const content = (
    <>
      {row.status ? <RowStatusIndicator status={row.status} /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm leading-snug text-foreground">{row.title}</div>
        {row.detail ? (
          <div className="truncate text-xs leading-snug text-muted-foreground">{row.detail}</div>
        ) : null}
      </div>
      {row.value ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{row.value}</span>
      ) : null}
      {canOpen ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      ) : null}
    </>
  );

  if (canOpen) {
    const threadId = linked.id;
    const title = linked.title.trim() || row.title;
    return (
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId }}
        onClick={(event) => {
          if (openQuestThread({ environmentId, threadId, title })) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        className="flex min-h-9 items-center gap-2.5 rounded-md px-1.5 py-1.5 -mx-1.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {content}
      </Link>
    );
  }

  return <div className="flex min-h-9 items-center gap-2.5 py-1.5">{content}</div>;
}

function CardStatsBlock({ stats }: { readonly stats: ReadonlyArray<CardStatItem> }) {
  const colsClass =
    stats.length === 1
      ? "grid-cols-1"
      : stats.length === 2
        ? "grid-cols-2"
        : stats.length === 3
          ? "grid-cols-3"
          : "grid-cols-2 sm:grid-cols-4";
  return (
    <div className={cn("grid gap-3", colsClass)}>
      {stats.map((stat, index) => {
        const sentiment = statDeltaSentiment(stat.delta, stat.tone);
        return (
          <div key={`${stat.label}-${index}`} className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-xl font-semibold leading-tight tracking-tight text-foreground tabular-nums">
                {stat.value}
              </span>
              {stat.delta ? (
                <span
                  className={cn(
                    "shrink-0 text-xs font-medium tabular-nums",
                    sentiment === "good"
                      ? "text-success"
                      : sentiment === "bad"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {stat.delta}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{stat.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function CardProgressBlock({ progress }: { readonly progress: CardProgress }) {
  const clamped = Math.min(100, Math.max(0, progress.percent));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{progress.label}</span>
        <span className="shrink-0 tabular-nums">{progress.eta ?? `${Math.round(clamped)}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label={progress.label}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/8"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out motion-reduce:transition-none"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function CardChartBlock({
  chart,
  resolvedTheme,
}: {
  readonly chart: CardChart;
  readonly resolvedTheme: "light" | "dark";
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const [axisMetrics, setAxisMetrics] = useState<{
    readonly width: number;
    readonly labelWidths: ReadonlyArray<number>;
  } | null>(null);
  const colors = cardChartSeriesColors(resolvedTheme);
  const pointCount = Math.max(...chart.series.map((s) => s.points.length), 1);
  const xLabels = useMemo(() => chart.xLabels?.slice(0, pointCount), [chart.xLabels, pointCount]);
  useLayoutEffect(() => {
    const axis = axisRef.current;
    if (!axis || !xLabels?.length) return;
    const labels = Array.from(axis.children);
    const measure = () => {
      const width = axis.getBoundingClientRect().width;
      const labelWidths = labels.map((label) => label.getBoundingClientRect().width);
      setAxisMetrics((current) =>
        current?.width === width &&
        current.labelWidths.length === labelWidths.length &&
        current.labelWidths.every((labelWidth, index) => labelWidth === labelWidths[index])
          ? current
          : { width, labelWidths },
      );
    };
    measure();
    return observeResize([axis, ...labels], measure);
  }, [xLabels]);

  const { min: minVal, max: maxVal } = cardChartRange(
    chart.kind,
    chart.series.flatMap((s) => s.points),
  );
  const range = maxVal - minVal;

  const width = 440;
  const height = 104;
  const padTop = 8;
  const padBottom = 6;
  const padX = 8;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;
  const bottomY = padTop + plotH;

  const xFor = (i: number) => {
    if (pointCount === 1) return padX + plotW / 2;
    if (chart.kind === "bar") {
      const slotW = plotW / pointCount;
      return padX + slotW * i + slotW / 2;
    }
    return padX + (i / (pointCount - 1)) * plotW;
  };
  const yFor = (val: number) => padTop + plotH - ((val - minVal) / range) * plotH;
  // Bars grow from zero, so the one baseline sits at zero for them.
  const baselineY = chart.kind === "bar" ? yFor(0) : bottomY;

  const axisWidth = axisMetrics?.width ?? 0;
  const labelPositions =
    axisMetrics && axisWidth > 0
      ? layoutChartXLabels(
          axisMetrics.labelWidths.map((labelWidth, index) => ({
            center: (xFor(index) / width) * axisWidth,
            width: labelWidth,
          })),
          axisWidth,
        )
      : [];
  const activeIndex = hoverIndex !== null && hoverIndex < pointCount ? hoverIndex : null;
  const slotWidth = plotW / pointCount;
  const barGroupWidth = Math.min(slotWidth * 0.72, 42);
  const singleBarWidth = Math.max(
    4,
    (barGroupWidth - (chart.series.length - 1) * 2) / chart.series.length,
  );

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-4 flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          {chart.series.length > 1 ? (
            chart.series.map((s, idx) => (
              <span
                key={`${s.label}-${idx}`}
                className="inline-flex items-center gap-1.5 text-muted-foreground"
              >
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: colors[idx % colors.length] }}
                />
                <span>{s.label}</span>
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">{chart.series[0]?.label}</span>
          )}
        </div>
        {activeIndex !== null ? (
          <div className="flex items-center gap-2 text-xs text-foreground tabular-nums">
            {chart.xLabels?.[activeIndex] ? (
              <span className="text-muted-foreground">{chart.xLabels[activeIndex]}</span>
            ) : null}
            {chart.series.map((s, idx) => {
              const v = s.points[activeIndex];
              if (v === undefined) return null;
              return (
                <span
                  key={`${s.label}-val-${idx}`}
                  className="inline-flex items-center gap-1 font-medium"
                >
                  {chart.series.length > 1 ? (
                    <span
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: colors[idx % colors.length] }}
                    />
                  ) : null}
                  {formatChartNumber(v)}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>

      <div
        className="relative h-[120px] w-full select-none"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="h-[100px] w-full overflow-visible"
          role="img"
          aria-label={chart.series.map((s) => s.label).join(", ")}
        >
          {/* Single hairline baseline */}
          <line
            x1={padX}
            y1={baselineY}
            x2={width - padX}
            y2={baselineY}
            stroke="currentColor"
            strokeOpacity={0.14}
            strokeWidth={1}
          />

          {/* Subtle vertical hover guide */}
          {activeIndex !== null ? (
            <line
              x1={xFor(activeIndex)}
              y1={padTop}
              x2={xFor(activeIndex)}
              y2={bottomY}
              stroke="currentColor"
              strokeOpacity={0.16}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          ) : null}

          {chart.kind === "bar"
            ? chart.series.map((s, sIdx) => {
                const color = colors[sIdx % colors.length];
                return s.points.map((val, i) => {
                  const cx = xFor(i);
                  const offset = -barGroupWidth / 2 + sIdx * (singleBarWidth + 2);
                  const bar = cardChartBar(val, yFor);
                  const dimmed = activeIndex !== null && activeIndex !== i;
                  return (
                    <rect
                      key={`${sIdx}-${i}`}
                      x={cx + offset}
                      y={bar.y}
                      width={singleBarWidth}
                      height={bar.height}
                      rx={3}
                      fill={color}
                      fillOpacity={dimmed ? 0.45 : 0.92}
                    />
                  );
                });
              })
            : chart.series.map((s, sIdx) => {
                const color = colors[sIdx % colors.length];
                const d = s.points
                  .map(
                    (val, i) =>
                      `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(val).toFixed(1)}`,
                  )
                  .join(" ");
                return (
                  <g key={sIdx}>
                    <path
                      d={d}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    {/* A one-point line has no segment to stroke: show the point. */}
                    {s.points.length === 1 && activeIndex === null ? (
                      <path
                        d={`M${xFor(0).toFixed(1)},${yFor(s.points[0]!).toFixed(1)}h0`}
                        stroke={color}
                        strokeWidth={6}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null}
                    {activeIndex !== null && s.points[activeIndex] !== undefined ? (
                      <circle
                        cx={xFor(activeIndex)}
                        cy={yFor(s.points[activeIndex]!)}
                        r={3.5}
                        fill={color}
                      />
                    ) : null}
                  </g>
                );
              })}

          {/* Invisible hover columns for crisp pointer tracking */}
          {Array.from({ length: pointCount }, (_, i) => (
            <rect
              key={`hit-${i}`}
              x={padX + i * slotWidth}
              y={0}
              width={slotWidth}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHoverIndex(i)}
            />
          ))}
        </svg>

        {xLabels && xLabels.length > 0 ? (
          <div
            ref={axisRef}
            className="relative h-5 w-full text-2xs text-muted-foreground tabular-nums"
          >
            {Array.from(xLabels.entries(), ([index, label]) => {
              const left = labelPositions[index];
              return (
                <span
                  key={index}
                  className="absolute top-0.5 w-max truncate"
                  style={{
                    left: left === undefined ? 0 : `${(left / axisWidth) * 100}%`,
                    maxWidth: xLabels.length === 1 ? "100%" : "calc(50% - 2px)",
                    visibility: left === undefined ? "hidden" : undefined,
                  }}
                >
                  {label}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CardImageBlock({
  image,
  environmentId,
  threadId,
  workspaceRoot,
  onImageExpand,
}: {
  readonly image: CardImage;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | undefined;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const viewed = useMemo(
    () => resolveViewedImageAsset(image.path, { threadId, workspaceRoot }),
    [image.path, threadId, workspaceRoot],
  );
  const assetState = useAssetUrlState(environmentId, viewed?.resource ?? null);
  const src = assetState._tag === "Success" ? assetState.url : null;

  if (!src) {
    return (
      <div className="flex min-h-20 items-center justify-center rounded-xl border border-border/60 bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
        {image.alt}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Open ${image.alt}`}
      onClick={() =>
        onImageExpand({
          index: 0,
          images: [
            {
              src,
              name: image.alt,
              ...(viewed
                ? {
                    actionsSource: {
                      kind: "image",
                      name: image.alt,
                      src,
                      asset: { environmentId, resource: viewed.resource },
                    },
                  }
                : {}),
            },
          ],
        })
      }
      className="block w-full cursor-zoom-in overflow-hidden rounded-xl border border-border/60 bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <img src={src} alt={image.alt} className="block max-h-72 w-full object-contain" />
    </button>
  );
}

/** Stepped slider matching Settings > Agents (`AgentLevelSlider`). */
function CardSteppedSlider({
  field,
  value,
  disabled,
  onChange,
}: {
  readonly field: CardInput;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (next: number) => void;
}) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = field.step ?? 1;
  const totalSteps = Math.max(1, Math.round((max - min) / step));
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shown = dragValue ?? value;
  const fraction = (shown - min) / Math.max(1e-9, max - min);
  const pct = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  const defaultVal =
    typeof field.default === "number" ? snapSliderValue(field.default, min, max, step) : null;
  const defaultPct =
    defaultVal !== null
      ? `${Math.min(100, Math.max(0, ((defaultVal - min) / Math.max(1e-9, max - min)) * 100))}%`
      : null;
  const showDots = totalSteps <= 10;

  const valueAt = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = (event.clientX - rect.left) / Math.max(1, rect.width);
    return snapSliderValue(min + raw * (max - min), min, max, step);
  };

  return (
    <div className={cn("select-none space-y-1", disabled && "opacity-65")}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{field.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatSliderValue(shown, field.unit)}
        </span>
      </div>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={field.label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={formatSliderValue(shown, field.unit)}
        aria-disabled={disabled}
        className={cn(
          "group/card-slider relative h-7 touch-none rounded-md outline-none",
          disabled ? "cursor-default" : "cursor-pointer",
        )}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            onChange(snapSliderValue(value - step, min, max, step));
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            onChange(snapSliderValue(value + step, min, max, step));
          } else if (event.key === "Home") {
            onChange(min);
          } else if (event.key === "End") {
            onChange(max);
          } else {
            return;
          }
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          setDragValue(valueAt(event));
        }}
        onPointerMove={(event) => {
          if (dragValue !== null) setDragValue(valueAt(event));
        }}
        onPointerUp={(event) => {
          if (dragValue === null) return;
          const next = valueAt(event);
          setDragValue(null);
          if (next !== value) onChange(next);
        }}
        onPointerCancel={() => setDragValue(null)}
      >
        <div className="absolute inset-x-2 inset-y-0">
          {defaultPct !== null ? (
            <span
              aria-hidden
              className="absolute top-0.5 size-1 -translate-x-1/2 rounded-full bg-muted-foreground/60"
              style={{ left: defaultPct }}
            />
          ) : null}
          <span
            aria-hidden
            className="absolute inset-x-0 top-4 h-1 -translate-y-1/2 rounded-full bg-input"
          />
          <span
            aria-hidden
            className="absolute left-0 top-4 h-1 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-120 ease-out motion-reduce:transition-none"
            style={{ width: pct }}
          />
          {showDots
            ? Array.from({ length: totalSteps + 1 }, (_, i) => {
                const stopVal = snapSliderValue(min + i * step, min, max, step);
                const stopPct = `${(i / totalSteps) * 100}%`;
                return (
                  <span
                    key={i}
                    aria-hidden
                    className={cn(
                      "absolute top-4 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                      stopVal <= shown ? "bg-primary" : "bg-muted-foreground/45",
                    )}
                    style={{ left: stopPct }}
                  />
                );
              })
            : null}
          <span
            aria-hidden
            className="absolute top-4 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-white shadow-sm transition-[left] duration-120 ease-out group-focus-visible/card-slider:ring-2 group-focus-visible/card-slider:ring-inset group-focus-visible/card-slider:ring-ring motion-reduce:transition-none"
            style={{ left: pct }}
          />
        </div>
      </div>
    </div>
  );
}

function CardInputField({
  field,
  value,
  disabled,
  onChange,
}: {
  readonly field: CardInput;
  readonly value: string | number | boolean | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: string | number | boolean) => void;
}) {
  const inputId = useId();

  switch (field.kind) {
    case "choice": {
      const options = field.options ?? [];
      const current = typeof value === "string" ? value : (options[0] ?? "");
      if (options.length <= 3) {
        return (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground">{field.label}</div>
            <div
              role="radiogroup"
              aria-label={field.label}
              className="grid gap-1 rounded-lg border border-border/60 bg-muted/70 p-0.5"
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, options.length)}, minmax(0, 1fr))`,
              }}
            >
              {options.map((option) => {
                const selected = option === current;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() => onChange(option)}
                    className={cn(
                      "truncate rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      disabled ? "cursor-default" : "cursor-pointer",
                      selected
                        ? "bg-card font-medium text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                      disabled && !selected && "opacity-50",
                    )}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>
        );
      }
      return (
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
            {field.label}
          </label>
          <div className="relative">
            <select
              id={inputId}
              disabled={disabled}
              value={current}
              onChange={(event) => onChange(event.target.value)}
              className={cn(
                "h-8 w-full appearance-none rounded-lg border border-input bg-background px-2.5 pr-8 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                disabled && "opacity-65",
              )}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <ChevronDownIcon
              className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
          </div>
        </div>
      );
    }
    case "slider":
      return (
        <CardSteppedSlider
          field={field}
          value={typeof value === "number" ? value : (field.min ?? 0)}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "toggle":
      return (
        <div className="flex items-center justify-between gap-3 py-0.5">
          <label htmlFor={inputId} className="text-xs font-medium text-foreground">
            {field.label}
          </label>
          <Switch
            id={inputId}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </div>
      );
    case "text":
      return (
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
            {field.label}
          </label>
          <input
            id={inputId}
            type="text"
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.label}
            className={cn(
              "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              disabled && "opacity-65",
            )}
          />
        </div>
      );
  }
}

function CardBlockView({
  block,
  environmentId,
  threadId,
  workspaceRoot,
  resolvedTheme,
  onImageExpand,
}: {
  readonly block: CardBlock;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  if ("text" in block) {
    return (
      <div className="text-sm leading-relaxed text-foreground/95 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
      </div>
    );
  }
  if ("rows" in block) {
    return (
      <div className="divide-y divide-border/60">
        {block.rows.map((row, idx) => (
          <CardRow key={`${row.title}-${idx}`} row={row} environmentId={environmentId} />
        ))}
      </div>
    );
  }
  if ("stats" in block) {
    return <CardStatsBlock stats={block.stats} />;
  }
  if ("progress" in block) {
    return <CardProgressBlock progress={block.progress} />;
  }
  if ("chart" in block) {
    return <CardChartBlock chart={block.chart} resolvedTheme={resolvedTheme} />;
  }
  return (
    <CardImageBlock
      image={block.image}
      environmentId={environmentId}
      threadId={threadId}
      workspaceRoot={workspaceRoot}
      onImageExpand={onImageExpand}
    />
  );
}

/** Skeleton card shown while a `show_card` tool call is still streaming / pending. */
export function AgentCardSkeleton({ title }: { readonly title?: string | undefined }) {
  return (
    <div
      data-agent-card="streaming"
      className="w-full rounded-2xl border border-border bg-card px-4 py-3.5"
    >
      <div className="flex items-center gap-2">
        <span className="size-[18px] shrink-0 rounded-full bg-muted animate-pulse motion-reduce:animate-none" />
        {title ? (
          <span className="truncate text-base font-semibold leading-snug text-foreground">
            {title}
          </span>
        ) : (
          <span className="h-4 w-40 rounded bg-muted animate-pulse motion-reduce:animate-none" />
        )}
      </div>
      <div className="mt-3 space-y-2">
        <div className="h-3 w-4/5 rounded bg-muted/80 animate-pulse motion-reduce:animate-none" />
        <div className="h-3 w-3/5 rounded bg-muted/60 animate-pulse motion-reduce:animate-none" />
      </div>
    </div>
  );
}

export interface AgentCardSendPayload {
  readonly text: string;
  readonly context: OrchestrationMessageContext;
}

export interface AgentCardProps {
  readonly itemId: string;
  readonly card: CardSpec;
  readonly lockedState: CardLockedState;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onReply?: ((payload: AgentCardSendPayload) => Promise<void>) | undefined;
}

export function AgentCard({
  itemId,
  card,
  lockedState,
  environmentId,
  threadId,
  workspaceRoot,
  resolvedTheme,
  onImageExpand,
  onReply,
}: AgentCardProps) {
  const defaultValues = useMemo(
    () => (card.inputs ? initialCardInputValues(card.inputs) : {}),
    [card.inputs],
  );
  const [draftValues, setDraftValues] = useState<Record<string, string | number | boolean>>(
    () => defaultValues,
  );
  const [localReply, setLocalReply] = useState<{
    readonly selectedActionIndex?: number;
    readonly submittedValues?: CardInputValues;
  } | null>(null);
  const [sending, setSending] = useState(false);

  const isLocked = lockedState.locked || localReply !== null || sending || onReply === undefined;
  const selectedActionIndex = lockedState.selectedActionIndex ?? localReply?.selectedActionIndex;
  const shownValues: CardInputValues =
    lockedState.submittedValues ?? localReply?.submittedValues ?? draftValues;

  const toneBar = TONE_BAR_CLASS[card.tone];

  const handleActionClick = async (action: CardAction, index: number) => {
    if (isLocked || !onReply) return;
    setSending(true);
    setLocalReply({ selectedActionIndex: index });
    try {
      await onReply({
        text: action.reply,
        context: buildCardReplyContext({
          itemId,
          kind: "action",
          actionIndex: index,
          label: action.label,
        }),
      });
    } catch {
      setLocalReply(null);
    } finally {
      setSending(false);
    }
  };

  const handleInputsSubmit = async () => {
    if (isLocked || !onReply || !card.inputs) return;
    const snapshot: Record<string, string | number | boolean> = {
      ...defaultValues,
      ...draftValues,
    };
    const text = formatCardInputsReply(card.inputs, snapshot);
    setSending(true);
    setLocalReply({ submittedValues: snapshot });
    try {
      await onReply({
        text,
        context: buildCardReplyContext({
          itemId,
          kind: "inputs",
          values: snapshot,
        }),
      });
    } catch {
      setLocalReply(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      data-agent-card={isLocked ? "locked" : "active"}
      data-card-tone={card.tone}
      className={cn(
        "relative w-full overflow-hidden rounded-2xl border border-border bg-card py-3.5 pr-4",
        toneBar ? "pl-4.75" : "pl-4",
      )}
    >
      {toneBar ? (
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", toneBar)} />
      ) : null}

      {/* Header */}
      <div className="flex items-start gap-2.5">
        {card.icon ? (
          <div className="mt-0.5">
            <CardHeaderIcon icon={card.icon} tone={card.tone} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold leading-snug text-foreground">{card.title}</div>
          {card.subtitle ? (
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{card.subtitle}</div>
          ) : null}
        </div>
      </div>

      {/* Blocks */}
      {card.blocks && card.blocks.length > 0 ? (
        <div className="mt-3 space-y-3">
          {card.blocks.map((block, index) => (
            <CardBlockView
              key={index}
              block={block}
              environmentId={environmentId}
              threadId={threadId}
              workspaceRoot={workspaceRoot}
              resolvedTheme={resolvedTheme}
              onImageExpand={onImageExpand}
            />
          ))}
        </div>
      ) : null}

      {/* Inputs + submit */}
      {card.inputs && card.inputs.length > 0 ? (
        <div className="mt-3.5 space-y-3 border-t border-border/60 pt-3">
          {card.inputs.map((field) => (
            <CardInputField
              key={field.id}
              field={field}
              value={shownValues[field.id]}
              disabled={isLocked}
              onChange={(next) => setDraftValues((prev) => ({ ...prev, [field.id]: next }))}
            />
          ))}
          <div className="flex justify-end pt-0.5">
            <button
              type="button"
              disabled={isLocked}
              onClick={() => void handleInputsSubmit()}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isLocked
                  ? "cursor-default bg-muted text-muted-foreground"
                  : "cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {lockedState.submittedValues || localReply?.submittedValues ? (
                <>
                  <CheckIcon className="size-3.5" aria-hidden />
                  <span>Sent</span>
                </>
              ) : (
                <span>{card.submit ?? "Send"}</span>
              )}
            </button>
          </div>
        </div>
      ) : null}

      {/* Actions */}
      {card.actions && card.actions.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2">
          {card.actions.map((action, index) => {
            const isPicked = selectedActionIndex === index;
            const isDimmed = isLocked && !isPicked;
            return (
              <button
                key={`${action.label}-${index}`}
                type="button"
                disabled={isLocked}
                onClick={() => void handleActionClick(action, index)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isLocked ? "cursor-default" : "cursor-pointer",
                  action.style === "primary"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : action.style === "danger"
                      ? "border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
                      : "border border-border bg-secondary/70 text-foreground hover:bg-secondary",
                  isDimmed && "opacity-40",
                  isPicked && "ring-2 ring-inset ring-ring/50",
                )}
              >
                {isPicked ? <CheckIcon className="size-3.5 shrink-0" aria-hidden /> : null}
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
