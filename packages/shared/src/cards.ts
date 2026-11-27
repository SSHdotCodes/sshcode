import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  type OrchestrationMessageContext,
  type UnknownContextRecord,
} from "@t3tools/contracts";

import { toKindScopedComposerContextId } from "./composerContextReferences.ts";
import { resolveT3McpDispatch, resolveT3McpToolId } from "./t3McpToolPresentation.ts";

export const SHOW_CARD_TOOL_NAME = "show_card";

export const SHOW_CARD_TOOL_DESCRIPTION =
  "Show the user a native card: title, short text, rows linking chats, stats, progress, a small chart, buttons that reply for them, or inputs they tune and send. Use for status, lists, choices and results; not for long text.";

export const CARD_TONES = ["neutral", "good", "warn", "bad"] as const;
export type CardTone = (typeof CARD_TONES)[number];

export const CARD_ICONS = [
  "chat",
  "check",
  "alert",
  "clock",
  "chart",
  "list",
  "spark",
  "bot",
] as const;
export type CardIcon = (typeof CARD_ICONS)[number];

export const CARD_ROW_STATUSES = ["running", "done", "failed", "waiting", "idle"] as const;
export type CardRowStatus = (typeof CARD_ROW_STATUSES)[number];

/** A stat's color when its sign misleads (lower latency is good). */
export const CARD_STAT_TONES = ["good", "bad", "neutral"] as const;
export type CardStatTone = (typeof CARD_STAT_TONES)[number];

export const CARD_ACTION_STYLES = ["primary", "plain", "danger"] as const;
export type CardActionStyle = (typeof CARD_ACTION_STYLES)[number];

export const CARD_INPUT_KINDS = ["choice", "slider", "toggle", "text"] as const;
export type CardInputKind = (typeof CARD_INPUT_KINDS)[number];

export const CARD_CHART_KINDS = ["bar", "line"] as const;
export type CardChartKind = (typeof CARD_CHART_KINDS)[number];

export const CARD_LIMITS = {
  title: 80,
  subtitle: 120,
  maxBlocks: 8,
  text: 600,
  maxRows: 12,
  rowTitle: 60,
  rowDetail: 100,
  rowValue: 24,
  rowChat: 200,
  maxStats: 4,
  statLabel: 24,
  statValue: 16,
  statDelta: 12,
  progressLabel: 60,
  progressEta: 24,
  maxChartSeries: 3,
  chartSeriesLabel: 24,
  maxChartPoints: 30,
  maxChartXLabels: 30,
  chartXLabel: 24,
  imagePath: 1024,
  imageAlt: 120,
  maxActions: 4,
  actionLabel: 24,
  actionReply: 300,
  maxInputs: 6,
  inputId: 24,
  inputLabel: 40,
  maxInputOptions: 6,
  inputOption: 40,
  inputUnit: 8,
  inputTextValue: 300,
  submit: 24,
} as const;

export interface CardRowItem {
  readonly title: string;
  readonly detail?: string;
  readonly status?: CardRowStatus;
  readonly chat?: string;
  readonly value?: string;
}

export interface CardStatItem {
  readonly label: string;
  readonly value: string;
  readonly delta?: string;
  /** Overrides the delta's sign color. */
  readonly tone?: CardStatTone;
}

export interface CardProgress {
  readonly percent: number;
  readonly label: string;
  readonly eta?: string;
}

export interface CardChartSeries {
  readonly label: string;
  readonly points: ReadonlyArray<number>;
}

export interface CardChart {
  readonly kind: CardChartKind;
  readonly series: ReadonlyArray<CardChartSeries>;
  readonly xLabels?: ReadonlyArray<string>;
}

export interface CardImage {
  readonly path: string;
  readonly alt: string;
}

export type CardBlock =
  | { readonly text: string }
  | { readonly rows: ReadonlyArray<CardRowItem> }
  | { readonly stats: ReadonlyArray<CardStatItem> }
  | { readonly progress: CardProgress }
  | { readonly chart: CardChart }
  | { readonly image: CardImage };

export interface CardAction {
  readonly label: string;
  readonly reply: string;
  readonly style: CardActionStyle;
}

export interface CardInput {
  readonly id: string;
  readonly kind: CardInputKind;
  readonly label: string;
  readonly options?: ReadonlyArray<string>;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly default?: string | number | boolean;
}

export interface CardSpec {
  readonly title: string;
  readonly subtitle?: string;
  readonly tone: CardTone;
  readonly icon?: CardIcon;
  readonly blocks?: ReadonlyArray<CardBlock>;
  readonly actions?: ReadonlyArray<CardAction>;
  readonly inputs?: ReadonlyArray<CardInput>;
  readonly submit?: string;
}

export type CardValidationResult =
  | { readonly ok: true; readonly card: CardSpec }
  | { readonly ok: false; readonly error: string };

const TONE_SET = new Set<string>(CARD_TONES);
const ICON_SET = new Set<string>(CARD_ICONS);
const STAT_TONE_SET = new Set<string>(CARD_STAT_TONES);
const ROW_STATUS_SET = new Set<string>(CARD_ROW_STATUSES);
const ACTION_STYLE_SET = new Set<string>(CARD_ACTION_STYLES);
const INPUT_KIND_SET = new Set<string>(CARD_INPUT_KINDS);
const CHART_KIND_SET = new Set<string>(CARD_CHART_KINDS);
const BLOCK_KEYS = ["text", "rows", "stats", "progress", "chart", "image"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trims a string to `max` code points, appending "…" when cut. */
export function trimCardText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  if (max <= 1) return "…";
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

function readOptionalTrimmed(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = trimCardText(value, max);
  return next.length > 0 ? next : undefined;
}

/** Validates `show_card` input, clamping/trimming lengths with "…" and returning a short error naming any bad field. */
export function validateAndNormalizeCardInput(raw: unknown): CardValidationResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "input: expected an object." };
  }
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    return { ok: false, error: "title: required non-empty string." };
  }
  const title = trimCardText(raw.title, CARD_LIMITS.title);
  if (raw.subtitle !== undefined && typeof raw.subtitle !== "string") {
    return { ok: false, error: "subtitle: expected a string." };
  }
  const subtitle = readOptionalTrimmed(raw.subtitle, CARD_LIMITS.subtitle);

  let tone: CardTone = "neutral";
  if (raw.tone !== undefined) {
    if (typeof raw.tone !== "string" || !TONE_SET.has(raw.tone)) {
      return { ok: false, error: `tone: expected one of ${CARD_TONES.join(", ")}.` };
    }
    tone = raw.tone as CardTone;
  }

  let icon: CardIcon | undefined;
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== "string" || !ICON_SET.has(raw.icon)) {
      return { ok: false, error: `icon: expected one of ${CARD_ICONS.join(", ")}.` };
    }
    icon = raw.icon as CardIcon;
  }

  let blocks: CardBlock[] | undefined;
  if (raw.blocks !== undefined) {
    if (!Array.isArray(raw.blocks)) {
      return { ok: false, error: "blocks: expected an array." };
    }
    blocks = [];
    const sliced = raw.blocks.slice(0, CARD_LIMITS.maxBlocks);
    for (let i = 0; i < sliced.length; i += 1) {
      const entry = sliced[i];
      if (!isRecord(entry)) {
        return { ok: false, error: `blocks[${i}]: expected an object.` };
      }
      const present = BLOCK_KEYS.filter((key) => entry[key] !== undefined);
      if (present.length !== 1) {
        return {
          ok: false,
          error: `blocks[${i}]: must have exactly one of ${BLOCK_KEYS.join(", ")}.`,
        };
      }
      const kind = present[0]!;
      switch (kind) {
        case "text": {
          if (typeof entry.text !== "string" || entry.text.trim().length === 0) {
            return { ok: false, error: `blocks[${i}].text: required non-empty string.` };
          }
          blocks.push({ text: trimCardText(entry.text, CARD_LIMITS.text) });
          break;
        }
        case "rows": {
          if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
            return { ok: false, error: `blocks[${i}].rows: expected a non-empty array.` };
          }
          const rows: CardRowItem[] = [];
          const rowSlice = entry.rows.slice(0, CARD_LIMITS.maxRows);
          for (let r = 0; r < rowSlice.length; r += 1) {
            const row = rowSlice[r];
            if (!isRecord(row) || typeof row.title !== "string" || row.title.trim().length === 0) {
              return {
                ok: false,
                error: `blocks[${i}].rows[${r}].title: required non-empty string.`,
              };
            }
            if (row.detail !== undefined && typeof row.detail !== "string") {
              return { ok: false, error: `blocks[${i}].rows[${r}].detail: expected a string.` };
            }
            if (row.value !== undefined && typeof row.value !== "string") {
              return { ok: false, error: `blocks[${i}].rows[${r}].value: expected a string.` };
            }
            if (row.chat !== undefined && typeof row.chat !== "string") {
              return {
                ok: false,
                error: `blocks[${i}].rows[${r}].chat: expected a thread id string.`,
              };
            }
            let status: CardRowStatus | undefined;
            if (row.status !== undefined) {
              if (typeof row.status !== "string" || !ROW_STATUS_SET.has(row.status)) {
                return {
                  ok: false,
                  error: `blocks[${i}].rows[${r}].status: expected one of ${CARD_ROW_STATUSES.join(", ")}.`,
                };
              }
              status = row.status as CardRowStatus;
            }
            const detail = readOptionalTrimmed(row.detail, CARD_LIMITS.rowDetail);
            const value = readOptionalTrimmed(row.value, CARD_LIMITS.rowValue);
            const chat =
              typeof row.chat === "string" && row.chat.trim().length > 0
                ? row.chat.trim()
                : undefined;
            if (chat !== undefined && chat.length > CARD_LIMITS.rowChat) {
              return {
                ok: false,
                error: `blocks[${i}].rows[${r}].chat: exceeds maximum length.`,
              };
            }
            rows.push({
              title: trimCardText(row.title, CARD_LIMITS.rowTitle),
              ...(detail !== undefined ? { detail } : {}),
              ...(status !== undefined ? { status } : {}),
              ...(chat !== undefined ? { chat } : {}),
              ...(value !== undefined ? { value } : {}),
            });
          }
          blocks.push({ rows });
          break;
        }
        case "stats": {
          if (!Array.isArray(entry.stats) || entry.stats.length === 0) {
            return { ok: false, error: `blocks[${i}].stats: expected a non-empty array.` };
          }
          const stats: CardStatItem[] = [];
          const statSlice = entry.stats.slice(0, CARD_LIMITS.maxStats);
          for (let s = 0; s < statSlice.length; s += 1) {
            const stat = statSlice[s];
            if (!isRecord(stat)) {
              return { ok: false, error: `blocks[${i}].stats[${s}]: expected an object.` };
            }
            if (typeof stat.label !== "string" || stat.label.trim().length === 0) {
              return {
                ok: false,
                error: `blocks[${i}].stats[${s}].label: required non-empty string.`,
              };
            }
            if (typeof stat.value !== "string" || stat.value.trim().length === 0) {
              return {
                ok: false,
                error: `blocks[${i}].stats[${s}].value: required non-empty string.`,
              };
            }
            if (stat.delta !== undefined && typeof stat.delta !== "string") {
              return { ok: false, error: `blocks[${i}].stats[${s}].delta: expected a string.` };
            }
            if (
              stat.tone !== undefined &&
              (typeof stat.tone !== "string" || !STAT_TONE_SET.has(stat.tone))
            ) {
              return {
                ok: false,
                error: `blocks[${i}].stats[${s}].tone: expected one of ${CARD_STAT_TONES.join(", ")}.`,
              };
            }
            const delta = readOptionalTrimmed(stat.delta, CARD_LIMITS.statDelta);
            stats.push({
              label: trimCardText(stat.label, CARD_LIMITS.statLabel),
              value: trimCardText(stat.value, CARD_LIMITS.statValue),
              ...(delta !== undefined ? { delta } : {}),
              ...(stat.tone !== undefined ? { tone: stat.tone as CardStatTone } : {}),
            });
          }
          blocks.push({ stats });
          break;
        }
        case "progress": {
          const progress = entry.progress;
          if (!isRecord(progress)) {
            return { ok: false, error: `blocks[${i}].progress: expected an object.` };
          }
          if (
            typeof progress.percent !== "number" ||
            !Number.isFinite(progress.percent) ||
            progress.percent < 0 ||
            progress.percent > 100
          ) {
            return {
              ok: false,
              error: `blocks[${i}].progress.percent: expected a number between 0 and 100.`,
            };
          }
          if (typeof progress.label !== "string" || progress.label.trim().length === 0) {
            return {
              ok: false,
              error: `blocks[${i}].progress.label: required non-empty string.`,
            };
          }
          if (progress.eta !== undefined && typeof progress.eta !== "string") {
            return { ok: false, error: `blocks[${i}].progress.eta: expected a string.` };
          }
          const eta = readOptionalTrimmed(progress.eta, CARD_LIMITS.progressEta);
          blocks.push({
            progress: {
              percent: Math.min(100, Math.max(0, progress.percent)),
              label: trimCardText(progress.label, CARD_LIMITS.progressLabel),
              ...(eta !== undefined ? { eta } : {}),
            },
          });
          break;
        }
        case "chart": {
          const chart = entry.chart;
          if (!isRecord(chart)) {
            return { ok: false, error: `blocks[${i}].chart: expected an object.` };
          }
          if (typeof chart.kind !== "string" || !CHART_KIND_SET.has(chart.kind)) {
            return {
              ok: false,
              error: `blocks[${i}].chart.kind: expected one of ${CARD_CHART_KINDS.join(", ")}.`,
            };
          }
          if (!Array.isArray(chart.series) || chart.series.length === 0) {
            return { ok: false, error: `blocks[${i}].chart.series: expected a non-empty array.` };
          }
          const series: CardChartSeries[] = [];
          const seriesSlice = chart.series.slice(0, CARD_LIMITS.maxChartSeries);
          for (let s = 0; s < seriesSlice.length; s += 1) {
            const item = seriesSlice[s];
            if (!isRecord(item)) {
              return { ok: false, error: `blocks[${i}].chart.series[${s}]: expected an object.` };
            }
            if (typeof item.label !== "string" || item.label.trim().length === 0) {
              return {
                ok: false,
                error: `blocks[${i}].chart.series[${s}].label: required non-empty string.`,
              };
            }
            if (!Array.isArray(item.points) || item.points.length === 0) {
              return {
                ok: false,
                error: `blocks[${i}].chart.series[${s}].points: expected a non-empty number array.`,
              };
            }
            const pointsSlice = item.points.slice(0, CARD_LIMITS.maxChartPoints);
            const points: number[] = [];
            for (let p = 0; p < pointsSlice.length; p += 1) {
              const point = pointsSlice[p];
              if (typeof point !== "number" || !Number.isFinite(point)) {
                return {
                  ok: false,
                  error: `blocks[${i}].chart.series[${s}].points[${p}]: expected a finite number.`,
                };
              }
              points.push(point);
            }
            series.push({
              label: trimCardText(item.label, CARD_LIMITS.chartSeriesLabel),
              points,
            });
          }
          let xLabels: string[] | undefined;
          if (chart.xLabels !== undefined) {
            if (!Array.isArray(chart.xLabels)) {
              return { ok: false, error: `blocks[${i}].chart.xLabels: expected a string array.` };
            }
            xLabels = [];
            const labelSlice = chart.xLabels.slice(0, CARD_LIMITS.maxChartXLabels);
            for (let l = 0; l < labelSlice.length; l += 1) {
              const label = labelSlice[l];
              if (typeof label !== "string") {
                return {
                  ok: false,
                  error: `blocks[${i}].chart.xLabels[${l}]: expected a string.`,
                };
              }
              xLabels.push(trimCardText(label, CARD_LIMITS.chartXLabel));
            }
          }
          blocks.push({
            chart: {
              kind: chart.kind as CardChartKind,
              series,
              ...(xLabels !== undefined && xLabels.length > 0 ? { xLabels } : {}),
            },
          });
          break;
        }
        case "image": {
          const image = entry.image;
          if (!isRecord(image)) {
            return { ok: false, error: `blocks[${i}].image: expected an object.` };
          }
          if (typeof image.path !== "string" || image.path.trim().length === 0) {
            return { ok: false, error: `blocks[${i}].image.path: required non-empty path.` };
          }
          const imagePath = image.path.trim();
          if (imagePath.length > CARD_LIMITS.imagePath) {
            return { ok: false, error: `blocks[${i}].image.path: exceeds maximum length.` };
          }
          if (typeof image.alt !== "string" || image.alt.trim().length === 0) {
            return { ok: false, error: `blocks[${i}].image.alt: required non-empty string.` };
          }
          blocks.push({
            image: {
              path: imagePath,
              alt: trimCardText(image.alt, CARD_LIMITS.imageAlt),
            },
          });
          break;
        }
      }
    }
  }

  let actions: CardAction[] | undefined;
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) {
      return { ok: false, error: "actions: expected an array." };
    }
    actions = [];
    const actionSlice = raw.actions.slice(0, CARD_LIMITS.maxActions);
    for (let i = 0; i < actionSlice.length; i += 1) {
      const action = actionSlice[i];
      if (!isRecord(action)) {
        return { ok: false, error: `actions[${i}]: expected an object.` };
      }
      if (typeof action.label !== "string" || action.label.trim().length === 0) {
        return { ok: false, error: `actions[${i}].label: required non-empty string.` };
      }
      if (typeof action.reply !== "string" || action.reply.trim().length === 0) {
        return { ok: false, error: `actions[${i}].reply: required non-empty string.` };
      }
      let style: CardActionStyle = "plain";
      if (action.style !== undefined) {
        if (typeof action.style !== "string" || !ACTION_STYLE_SET.has(action.style)) {
          return {
            ok: false,
            error: `actions[${i}].style: expected one of ${CARD_ACTION_STYLES.join(", ")}.`,
          };
        }
        style = action.style as CardActionStyle;
      }
      actions.push({
        label: trimCardText(action.label, CARD_LIMITS.actionLabel),
        reply: trimCardText(action.reply, CARD_LIMITS.actionReply),
        style,
      });
    }
  }

  let inputs: CardInput[] | undefined;
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs)) {
      return { ok: false, error: "inputs: expected an array." };
    }
    inputs = [];
    const seenIds = new Set<string>();
    const inputSlice = raw.inputs.slice(0, CARD_LIMITS.maxInputs);
    for (let i = 0; i < inputSlice.length; i += 1) {
      const field = inputSlice[i];
      if (!isRecord(field)) {
        return { ok: false, error: `inputs[${i}]: expected an object.` };
      }
      if (typeof field.id !== "string" || field.id.trim().length === 0) {
        return { ok: false, error: `inputs[${i}].id: required non-empty string.` };
      }
      const id = trimCardText(field.id, CARD_LIMITS.inputId);
      if (seenIds.has(id)) {
        return { ok: false, error: `inputs[${i}].id: duplicate id "${id}".` };
      }
      seenIds.add(id);
      if (typeof field.kind !== "string" || !INPUT_KIND_SET.has(field.kind)) {
        return {
          ok: false,
          error: `inputs[${i}].kind: expected one of ${CARD_INPUT_KINDS.join(", ")}.`,
        };
      }
      const kind = field.kind as CardInputKind;
      if (typeof field.label !== "string" || field.label.trim().length === 0) {
        return { ok: false, error: `inputs[${i}].label: required non-empty string.` };
      }
      const label = trimCardText(field.label, CARD_LIMITS.inputLabel);

      let options: string[] | undefined;
      if (kind === "choice") {
        if (!Array.isArray(field.options) || field.options.length === 0) {
          return {
            ok: false,
            error: `inputs[${i}].options: choice input requires a non-empty string array.`,
          };
        }
        options = [];
        const optSlice = field.options.slice(0, CARD_LIMITS.maxInputOptions);
        for (let o = 0; o < optSlice.length; o += 1) {
          const opt = optSlice[o];
          if (typeof opt !== "string" || opt.trim().length === 0) {
            return {
              ok: false,
              error: `inputs[${i}].options[${o}]: required non-empty string.`,
            };
          }
          options.push(trimCardText(opt, CARD_LIMITS.inputOption));
        }
      }

      let min: number | undefined;
      let max: number | undefined;
      let step: number | undefined;
      let unit: string | undefined;
      if (kind === "slider") {
        min = typeof field.min === "number" && Number.isFinite(field.min) ? field.min : 0;
        max = typeof field.max === "number" && Number.isFinite(field.max) ? field.max : 100;
        if (
          field.min !== undefined &&
          (typeof field.min !== "number" || !Number.isFinite(field.min))
        ) {
          return { ok: false, error: `inputs[${i}].min: expected a finite number.` };
        }
        if (
          field.max !== undefined &&
          (typeof field.max !== "number" || !Number.isFinite(field.max))
        ) {
          return { ok: false, error: `inputs[${i}].max: expected a finite number.` };
        }
        if (max <= min) {
          return { ok: false, error: `inputs[${i}].max: must be greater than min.` };
        }
        if (field.step !== undefined) {
          if (typeof field.step !== "number" || !Number.isFinite(field.step) || field.step <= 0) {
            return { ok: false, error: `inputs[${i}].step: expected a positive number.` };
          }
          step = field.step;
        } else {
          step = 1;
        }
        if (field.unit !== undefined) {
          if (typeof field.unit !== "string") {
            return { ok: false, error: `inputs[${i}].unit: expected a string.` };
          }
          unit = readOptionalTrimmed(field.unit, CARD_LIMITS.inputUnit);
        }
      }

      let defaultValue: string | number | boolean | undefined;
      if (field.default !== undefined) {
        if (typeof field.default === "string") {
          const maxLen = kind === "choice" ? CARD_LIMITS.inputOption : CARD_LIMITS.inputTextValue;
          defaultValue = trimCardText(field.default, maxLen);
        } else if (
          (typeof field.default === "number" && Number.isFinite(field.default)) ||
          typeof field.default === "boolean"
        ) {
          defaultValue = field.default;
        } else {
          return { ok: false, error: `inputs[${i}].default: invalid default value.` };
        }
      }

      inputs.push({
        id,
        kind,
        label,
        ...(options !== undefined ? { options } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      });
    }
  }

  if (raw.submit !== undefined && typeof raw.submit !== "string") {
    return { ok: false, error: "submit: expected a string." };
  }
  const submit = readOptionalTrimmed(raw.submit, CARD_LIMITS.submit);

  return {
    ok: true,
    card: {
      title,
      ...(subtitle !== undefined ? { subtitle } : {}),
      tone,
      ...(icon !== undefined ? { icon } : {}),
      ...(blocks !== undefined && blocks.length > 0 ? { blocks } : {}),
      ...(actions !== undefined && actions.length > 0 ? { actions } : {}),
      ...(inputs !== undefined && inputs.length > 0 ? { inputs } : {}),
      ...(submit !== undefined ? { submit } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tool-call detection (any MCP server prefix + deferred t3_tool dispatch)
// ---------------------------------------------------------------------------

const ANY_PREFIX_SHOW_CARD = /(?:^|(?:__|[:./\- ]))show_card$/i;

function unwrapToolInput(value: unknown): unknown {
  let current = value;
  if (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(current)) return current;
  // Cursor stores `{ toolName, args }`, ACP/Codex may store `{ server, tool, arguments }`.
  if (typeof current.toolName === "string" && isRecord(current.args)) {
    return current.args;
  }
  if (typeof current.tool === "string" && isRecord(current.arguments)) {
    return current.arguments;
  }
  return current;
}

/** True when a dynamic tool item represents a `show_card` call under any MCP prefix or via `t3_tool`. */
export function isShowCardToolCall(toolName: string | null | undefined, input?: unknown): boolean {
  if (toolName == null) return false;
  if (resolveT3McpToolId(toolName) === SHOW_CARD_TOOL_NAME) return true;
  if (ANY_PREFIX_SHOW_CARD.test(toolName.trim())) return true;
  const dispatch = resolveT3McpDispatch(toolName, unwrapToolInput(input));
  return dispatch !== undefined && dispatch.tool === SHOW_CARD_TOOL_NAME && !dispatch.lookup;
}

/** Extracts the raw `show_card` arguments from a tool call item (including wrapped/deferred calls). */
export function extractShowCardRawInput(
  toolName: string | null | undefined,
  input: unknown,
): Record<string, unknown> | undefined {
  if (!isShowCardToolCall(toolName, input)) return undefined;
  const unwrapped = unwrapToolInput(input);
  const dispatch = resolveT3McpDispatch(toolName ?? undefined, unwrapped);
  const payload =
    dispatch !== undefined && dispatch.tool === SHOW_CARD_TOOL_NAME && !dispatch.lookup
      ? dispatch.input
      : unwrapped;
  return isRecord(payload) ? payload : undefined;
}

function outputIndicatesError(output: unknown, depth = 0): boolean {
  if (depth > 4 || output == null) return false;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return outputIndicatesError(JSON.parse(trimmed), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(output)) {
    return output.some((entry) => outputIndicatesError(entry, depth + 1));
  }
  if (!isRecord(output)) return false;
  if (output.isError === true || output.is_error === true || output.error != null) return true;
  if (output._tag === "OrchestratorMcpFailure") return true;
  if (output.ok === false) return true;
  if (isRecord(output.structuredContent) && output.structuredContent.ok === false) return true;
  if (Array.isArray(output.content) && outputIndicatesError(output.content, depth + 1)) {
    return true;
  }
  if (output.type === "text" && typeof output.text === "string") {
    return outputIndicatesError(output.text, depth + 1);
  }
  return false;
}

export interface AgentCardToolPresentation {
  readonly state: "streaming" | "ready";
  readonly card?: CardSpec;
  readonly streamingTitle?: string;
}

/**
 * Resolves a `dynamic_tool` turn item into a native card presentation:
 * - While pending/running: returns `{ state: "streaming", streamingTitle }` for the skeleton card.
 * - When completed without error and valid input: returns `{ state: "ready", card }`.
 * - Failed / error / non-card items return `undefined` (staying on the ordinary work row).
 */
export function cardFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly status: string;
  readonly input?: unknown;
  readonly output?: unknown;
}): AgentCardToolPresentation | undefined {
  if (!isShowCardToolCall(item.toolName, item.input)) return undefined;
  if (item.status === "failed" || item.status === "cancelled" || item.status === "interrupted") {
    return undefined;
  }
  const raw = extractShowCardRawInput(item.toolName, item.input);
  if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
    const title =
      raw && typeof raw.title === "string"
        ? readOptionalTrimmed(raw.title, CARD_LIMITS.title)
        : undefined;
    return {
      state: "streaming",
      ...(title !== undefined ? { streamingTitle: title } : {}),
    };
  }
  if (item.status !== "completed" || outputIndicatesError(item.output)) {
    return undefined;
  }
  const validated = validateAndNormalizeCardInput(raw);
  if (!validated.ok) return undefined;
  return { state: "ready", card: validated.card };
}

/** Structural equality for memoized timeline rows. */
export function cardPresentationsEqual(
  left: AgentCardToolPresentation,
  right: AgentCardToolPresentation,
): boolean {
  if (left.state !== right.state || left.streamingTitle !== right.streamingTitle) return false;
  if (left.card === right.card) return true;
  if (!left.card || !right.card) return false;
  return JSON.stringify(left.card) === JSON.stringify(right.card);
}

// ---------------------------------------------------------------------------
// Input defaults, slider snapping, and reply formatting
// ---------------------------------------------------------------------------

export type CardInputValues = Readonly<Record<string, string | number | boolean>>;

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const [mantissa = "", expPart] = text.split("e");
  const frac = mantissa.split(".")[1]?.length ?? 0;
  const exp = expPart !== undefined ? Number.parseInt(expPart, 10) : 0;
  return Math.max(0, frac - exp);
}

export function snapSliderValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.isFinite(value) ? value : 0;
  const clamped = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  if (!Number.isFinite(step) || step <= 0) return clamped;
  const steps = Math.round((clamped - min) / step);
  const snapped = Math.min(max, Math.max(min, min + steps * step));
  // Avoid floating-point drift like 0.30000000000000004, including scientific-notation steps.
  const decimals = Math.max(decimalPlaces(step), decimalPlaces(min));
  if (decimals === 0) return Math.round(snapped);
  if (decimals > 20) return snapped;
  return Number(snapped.toFixed(decimals));
}

export function formatSliderValue(value: number, unit?: string): string {
  if (!unit) return String(value);
  return unit.startsWith("%") || unit === "°" || unit === "x"
    ? `${value}${unit}`
    : `${value} ${unit}`;
}

export function initialCardInputValues(
  inputs: ReadonlyArray<CardInput>,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of inputs) {
    switch (field.kind) {
      case "choice": {
        const opts = field.options ?? [];
        const def =
          typeof field.default === "string" && opts.includes(field.default)
            ? field.default
            : (opts[0] ?? "");
        values[field.id] = def;
        break;
      }
      case "slider": {
        const min = field.min ?? 0;
        const max = field.max ?? 100;
        const step = field.step ?? 1;
        const raw = typeof field.default === "number" ? field.default : min;
        values[field.id] = snapSliderValue(raw, min, max, step);
        break;
      }
      case "toggle": {
        values[field.id] = typeof field.default === "boolean" ? field.default : false;
        break;
      }
      case "text": {
        values[field.id] = typeof field.default === "string" ? field.default : "";
        break;
      }
    }
  }
  return values;
}

export function formatCardInputValue(
  field: CardInput,
  value: string | number | boolean | undefined,
): string {
  switch (field.kind) {
    case "toggle":
      return value === true ? "On" : "Off";
    case "slider": {
      const numeric = typeof value === "number" ? value : (field.min ?? 0);
      return formatSliderValue(numeric, field.unit);
    }
    case "choice":
      return typeof value === "string" ? value : (field.options?.[0] ?? "");
    case "text":
      return typeof value === "string" ? trimCardText(value, CARD_LIMITS.inputTextValue) : "";
  }
}

/** Formats inputs + submit into one compact message: `"<label>: <value>; <label>: <value>"`. */
export function formatCardInputsReply(
  inputs: ReadonlyArray<CardInput>,
  values: CardInputValues,
): string {
  const parts: string[] = [];
  for (const field of inputs) {
    const formatted = formatCardInputValue(field, values[field.id]);
    if (field.kind === "text" && formatted.length === 0) continue;
    parts.push(`${field.label}: ${formatted}`);
  }
  if (parts.length === 0 && inputs.length > 0) {
    const first = inputs[0]!;
    return `${first.label}: ${formatCardInputValue(first, values[first.id]) || "(empty)"}`;
  }
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Hidden card-reply metadata (stored via UnknownContextRecord, zero contract changes)
// ---------------------------------------------------------------------------

export const CARD_REPLY_CONTEXT_KIND = "card-reply";

export interface CardReplyMetadata {
  readonly itemId: string;
  readonly kind: "action" | "inputs";
  readonly label?: string;
  readonly actionIndex?: number;
  readonly values?: CardInputValues;
}

const CARD_REPLY_PAYLOAD_MAX_BYTES = 64_000;

/** Builds an `OrchestrationMessageContext` carrying a hidden `card-reply` marker (unreferenced in text, so invisible to providers). */
export function buildCardReplyContext(meta: CardReplyMetadata): OrchestrationMessageContext {
  const cleanLabel = readOptionalTrimmed(meta.label, COMPOSER_CONTEXT_LABEL_MAX_CHARS);
  const actionIndex =
    typeof meta.actionIndex === "number" && Number.isInteger(meta.actionIndex)
      ? meta.actionIndex
      : undefined;
  let cleanValues: Record<string, string | number | boolean> | undefined;
  if (meta.values !== undefined) {
    cleanValues = {};
    for (const [k, v] of Object.entries(meta.values)) {
      if (typeof v === "string") {
        cleanValues[k] = trimCardText(v, CARD_LIMITS.inputTextValue);
      } else if (typeof v === "number") {
        if (Number.isFinite(v)) cleanValues[k] = v;
      } else if (typeof v === "boolean") {
        cleanValues[k] = v;
      }
    }
  }
  const basePayload: Record<string, unknown> = {
    itemId: meta.itemId,
    kind: meta.kind,
    ...(cleanLabel !== undefined ? { label: cleanLabel } : {}),
    ...(actionIndex !== undefined ? { actionIndex } : {}),
  };
  const payload: Record<string, unknown> =
    cleanValues !== undefined ? { ...basePayload, values: cleanValues } : basePayload;
  const safePayload =
    JSON.stringify(payload).length <= CARD_REPLY_PAYLOAD_MAX_BYTES ? payload : basePayload;
  const record: UnknownContextRecord = {
    version: 1,
    contextId: toKindScopedComposerContextId(CARD_REPLY_CONTEXT_KIND, meta.itemId),
    kind: CARD_REPLY_CONTEXT_KIND,
    label: cleanLabel ?? "Card reply",
    payload: safePayload,
  };
  return {
    version: 1,
    records: [record],
  };
}

/** Extracts `CardReplyMetadata` from a user message's `context`, if it came from a card. */
export function readCardReplyFromContext(
  context: OrchestrationMessageContext | null | undefined,
): CardReplyMetadata | null {
  if (!context) return null;
  for (const record of context.records) {
    if (record.kind !== CARD_REPLY_CONTEXT_KIND || !("payload" in record)) continue;
    const payload = record.payload;
    if (!isRecord(payload) || typeof payload.itemId !== "string") continue;
    const kind = payload.kind === "action" || payload.kind === "inputs" ? payload.kind : "action";
    const label =
      typeof payload.label === "string" && payload.label.length > 0 ? payload.label : undefined;
    const actionIndex =
      typeof payload.actionIndex === "number" && Number.isInteger(payload.actionIndex)
        ? payload.actionIndex
        : undefined;
    let values: Record<string, string | number | boolean> | undefined;
    if (isRecord(payload.values)) {
      const parsed: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(payload.values)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          parsed[k] = v;
        }
      }
      values = parsed;
    }
    return {
      itemId: payload.itemId,
      kind,
      ...(label !== undefined ? { label } : {}),
      ...(actionIndex !== undefined ? { actionIndex } : {}),
      ...(values !== undefined ? { values } : {}),
    };
  }
  return null;
}

/** What the user bubble displays when a message came from a card action or input submit. */
export function cardReplyUserBubbleText(message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | null | undefined;
}): { readonly displayText: string; readonly fromCard: boolean } {
  const reply = readCardReplyFromContext(message.context);
  if (!reply) return { displayText: message.text, fromCard: false };
  if (reply.kind === "action" && reply.label) {
    return { displayText: reply.label, fromCard: true };
  }
  return { displayText: message.text, fromCard: true };
}

// ---------------------------------------------------------------------------
// Locked state derivation (survives reload; old turns stay readable but inert)
// ---------------------------------------------------------------------------

export interface CardLockedState {
  readonly locked: boolean;
  readonly selectedActionIndex?: number;
  readonly selectedActionLabel?: string;
  readonly submittedValues?: CardInputValues;
}

export interface TimelineCardScanMessage {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | null | undefined;
  /** Who wrote it; only the user's own messages answer a card. */
  readonly createdBy?: string | undefined;
  /** Set on a scheduled task's prompt, which never answers a card. */
  readonly scheduledTaskId?: string | undefined;
}

const writtenByUser = (message: TimelineCardScanMessage) =>
  (message.createdBy === undefined || message.createdBy === "user") &&
  message.scheduledTaskId === undefined;

function parseValuesFromFormattedReply(
  inputs: ReadonlyArray<CardInput>,
  text: string,
): Record<string, string | number | boolean> | undefined {
  const segments = text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  const byLabel = new Map(inputs.map((field) => [field.label, field] as const));
  const result: Record<string, string | number | boolean> = {};
  let matched = 0;
  for (const segment of segments) {
    const colon = segment.indexOf(":");
    if (colon <= 0) continue;
    const label = segment.slice(0, colon).trim();
    const rawVal = segment.slice(colon + 1).trim();
    const field = byLabel.get(label);
    if (!field) continue;
    matched += 1;
    switch (field.kind) {
      case "toggle":
        result[field.id] = rawVal.toLowerCase() === "on" || rawVal.toLowerCase() === "true";
        break;
      case "slider": {
        const numeric = Number.parseFloat(rawVal);
        if (Number.isFinite(numeric)) {
          result[field.id] = snapSliderValue(
            numeric,
            field.min ?? 0,
            field.max ?? 100,
            field.step ?? 1,
          );
        }
        break;
      }
      case "choice":
      case "text":
        result[field.id] = rawVal;
        break;
    }
  }
  return matched > 0 ? result : undefined;
}

/**
 * Derives whether a card is locked from subsequent user messages in the timeline.
 * - Matches exact `card-reply` metadata first (`payload.itemId === cardItemId`).
 * - Falls back to matching subsequent user message text against action replies or input format.
 * - If ANY user message appears after the card (an old, already-answered turn), locks as inert.
 * Messages the user didn't write (a routine's prompt, another chat's agent) are skipped.
 */
export function resolveCardLockedState(
  cardItemId: string,
  card: CardSpec,
  laterUserRoleMessages: ReadonlyArray<TimelineCardScanMessage>,
): CardLockedState {
  const subsequentUserMessages = laterUserRoleMessages.every(writtenByUser)
    ? laterUserRoleMessages
    : laterUserRoleMessages.filter(writtenByUser);
  if (subsequentUserMessages.length === 0) {
    return { locked: false };
  }
  // 1. Exact metadata match by itemId.
  for (const message of subsequentUserMessages) {
    const meta = readCardReplyFromContext(message.context);
    if (meta && meta.itemId === cardItemId) {
      if (meta.kind === "action") {
        const idx =
          meta.actionIndex !== undefined && card.actions?.[meta.actionIndex] !== undefined
            ? meta.actionIndex
            : card.actions?.findIndex(
                (action) => action.label === meta.label || action.reply === message.text,
              );
        return {
          locked: true,
          ...(idx !== undefined && idx >= 0 ? { selectedActionIndex: idx } : {}),
          ...(meta.label !== undefined ? { selectedActionLabel: meta.label } : {}),
        };
      }
      return {
        locked: true,
        ...(meta.values !== undefined ? { submittedValues: meta.values } : {}),
      };
    }
  }
  // 2. Text fallback match against actions or inputs.
  for (const message of subsequentUserMessages) {
    const trimmed = message.text.trim();
    if (card.actions) {
      const idx = card.actions.findIndex(
        (action) => action.reply === trimmed || action.label === trimmed,
      );
      if (idx >= 0) {
        return {
          locked: true,
          selectedActionIndex: idx,
          selectedActionLabel: card.actions[idx]!.label,
        };
      }
    }
    if (card.inputs && card.inputs.length > 0) {
      const parsed = parseValuesFromFormattedReply(card.inputs, trimmed);
      if (parsed) {
        return { locked: true, submittedValues: parsed };
      }
    }
  }
  // 3. Old, already-answered turn: readable but inert.
  return { locked: true };
}

// ---------------------------------------------------------------------------
// Chart layout & dataviz helpers
// ---------------------------------------------------------------------------

/** Positions measured x-axis labels, keeping the largest evenly spaced set that fits. */
export function layoutChartXLabels(
  labels: ReadonlyArray<{ readonly center: number; readonly width: number }>,
  axisWidth: number,
): ReadonlyArray<number | undefined> {
  const gap = 4;
  const ticks = labels.flatMap(({ center, width }, index) =>
    width > 0
      ? [{ index, width, left: Math.max(0, Math.min(center - width / 2, axisWidth - width)) }]
      : [],
  );
  const positions: Array<number | undefined> = labels.map(() => undefined);
  const first = ticks[0];
  const last = ticks.at(-1);
  if (!first || !last) return positions;
  if (first === last) {
    positions[first.index] = first.left;
    return positions;
  }

  for (let count = ticks.length; count >= 2; count -= 1) {
    const step = (ticks.length - 1) / (count - 1);
    const chosen = Array.from({ length: count }, (_, index) => ticks[Math.round(index * step)]!);
    if (
      chosen.every(
        (tick, index) =>
          index === 0 || chosen[index - 1]!.left + chosen[index - 1]!.width + gap <= tick.left,
      )
    ) {
      for (const tick of chosen) positions[tick.index] = tick.left;
      return positions;
    }
  }
  // Keep both endpoints even when their anchors are too close together.
  positions[first.index] = 0;
  positions[last.index] = Math.max(0, axisWidth - last.width);
  return positions;
}

/**
 * A chart's value scale. Bars always have zero on the scale (all-negative bars hang from a zero
 * line at the top) and otherwise fit the data, so small values fill the plot. Lines keep
 * zero and one on the scale, as before.
 */
export function cardChartRange(
  kind: CardChartKind,
  values: ReadonlyArray<number>,
): { readonly min: number; readonly max: number } {
  if (kind === "bar") {
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    return max === min ? { min, max: min + 1 } : { min, max };
  }
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  return { min, max: max === min ? min + 1 : max };
}

/**
 * One bar's rect, grown from zero: positive values rise from the zero line and negative ones
 * hang below it. A zero or tiny value keeps a `minHeight` sliver on its own side of zero.
 */
export function cardChartBar(
  value: number,
  yFor: (value: number) => number,
  minHeight = 2,
): { readonly y: number; readonly height: number } {
  const zero = yFor(0);
  const end = yFor(value);
  const height = Math.abs(zero - end);
  if (height >= minHeight) return { y: Math.min(zero, end), height };
  return { y: value < 0 ? zero : zero - minHeight, height: minHeight };
}

/** Categorical series palette matching `FIXED_COLORS.chart` (up to 3 series). */
export function cardChartSeriesColors(
  appearance: "light" | "dark",
  accentColor?: string,
): readonly [string, string, string] {
  if (appearance === "dark") {
    return [accentColor ?? "#60a5fa", "#2dd4bf", "#fbbf24"];
  }
  return [accentColor ?? "#2563eb", "#0d9488", "#d97706"];
}

/**
 * Classifies a stat delta for coloring: the stat's `tone` when set, else by sign
 * (+ green, -/minus red, else neutral).
 */
export function statDeltaSentiment(
  delta: string | undefined,
  tone?: CardStatTone,
): "good" | "bad" | "neutral" {
  if (tone !== undefined) return tone;
  if (!delta) return "neutral";
  const trimmed = delta.trim();
  if (trimmed.startsWith("+")) return "good";
  if (trimmed.startsWith("-") || trimmed.startsWith("−")) return "bad";
  return "neutral";
}

/** Formats a chart numeric value cleanly for hover/tap readouts. */
export function formatChartNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return Math.abs(value) >= 100 ? value.toFixed(1) : Number(value.toFixed(2)).toString();
}
