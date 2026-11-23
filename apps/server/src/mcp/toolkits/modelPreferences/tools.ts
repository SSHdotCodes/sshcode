import {
  ModelPreferencesQuery,
  ModelPreferencesResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as ModelPreferences from "../../../provider/ModelPreferences.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ModelPreferencesTool = Tool.make("model_preferences", {
  description:
    "Read this environment's user-edited model family rankings for a task or category. Returns up to 5 ranked families resolved to current available models (3 by default), with canonical providerInstanceId, model, family and a short user note. Explicit user choices come first; check the current catalog and quota. New releases inherit family ranks. Never use an old, legacy or supersededBy model without a concrete reason, such as an exact user request, and explain the exception. Only the user edits rankings, in Settings > Model family rankings. Needs a normal agent thread.",
  parameters: ModelPreferencesQuery,
  success: ModelPreferencesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, ModelPreferences.ModelPreferences],
})
  .annotate(Tool.Title, "Model preferences")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ModelPreferencesToolkit = Toolkit.make(ModelPreferencesTool);
