import { type AgentBehaviorLevels, OrchestratorMcpFailure } from "@t3tools/contracts";
import { currentAgentBehavior } from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  CARD_ACTION_STYLES,
  CARD_CHART_KINDS,
  CARD_ICONS,
  CARD_INPUT_KINDS,
  CARD_ROW_STATUSES,
  CARD_STAT_TONES,
  CARD_TONES,
  SHOW_CARD_TOOL_DESCRIPTION,
  SHOW_CARD_TOOL_NAME,
} from "@t3tools/shared/cards";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

let eagerCardsCheck: (threadId: string) => boolean = () => false;

/**
 * Registers a predicate for chats (such as bot home chats) where `show_card`
 * should always be offered eagerly regardless of Settings > Agents Token use.
 */
export function registerEagerCardsCheck(check: (threadId: string) => boolean): void {
  eagerCardsCheck = check;
}

/** True when `show_card` should be offered eagerly for `threadId`. */
export function cardsAreEager(
  threadId: string | undefined,
  behavior: AgentBehaviorLevels = currentAgentBehavior(),
): boolean {
  return behavior.tokens === "high" || (threadId !== undefined && eagerCardsCheck(threadId));
}

const CardRowSchema = Schema.Struct({
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(CARD_ROW_STATUSES)),
  chat: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});

const CardStatSchema = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  delta: Schema.optional(Schema.String),
  tone: Schema.optional(Schema.Literals(CARD_STAT_TONES)).annotate({
    description: "Overrides the sign color when lower is better",
  }),
});

const CardProgressSchema = Schema.Struct({
  percent: Schema.Number,
  label: Schema.String,
  eta: Schema.optional(Schema.String),
});

const CardChartSeriesSchema = Schema.Struct({
  label: Schema.String,
  points: Schema.Array(Schema.Number),
});

const CardChartSchema = Schema.Struct({
  kind: Schema.Literals(CARD_CHART_KINDS),
  series: Schema.Array(CardChartSeriesSchema),
  xLabels: Schema.optional(Schema.Array(Schema.String)),
});

const CardImageSchema = Schema.Struct({
  path: Schema.String,
  alt: Schema.String,
});

const CardBlockSchema = Schema.Struct({
  text: Schema.optional(Schema.String),
  rows: Schema.optional(Schema.Array(CardRowSchema)),
  stats: Schema.optional(Schema.Array(CardStatSchema)),
  progress: Schema.optional(CardProgressSchema),
  chart: Schema.optional(CardChartSchema),
  image: Schema.optional(CardImageSchema),
});

const CardActionSchema = Schema.Struct({
  label: Schema.String,
  reply: Schema.String,
  style: Schema.optional(Schema.Literals(CARD_ACTION_STYLES)),
});

const CardInputSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(CARD_INPUT_KINDS),
  label: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  step: Schema.optional(Schema.Number),
  unit: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
});

export const ShowCardTool = Tool.make(SHOW_CARD_TOOL_NAME, {
  description: SHOW_CARD_TOOL_DESCRIPTION,
  parameters: Schema.Struct({
    title: Schema.String,
    subtitle: Schema.optional(Schema.String),
    tone: Schema.optional(Schema.Literals(CARD_TONES)),
    icon: Schema.optional(Schema.Literals(CARD_ICONS)),
    blocks: Schema.optional(Schema.Array(CardBlockSchema)),
    actions: Schema.optional(Schema.Array(CardActionSchema)),
    inputs: Schema.optional(Schema.Array(CardInputSchema)),
    submit: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    ok: Schema.Literal(true),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ServerConfig.ServerConfig,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Show card")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const CardToolkit = Toolkit.make(ShowCardTool);
