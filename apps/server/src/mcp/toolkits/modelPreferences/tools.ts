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
    "Read user-edited model family rankings for a task. Returns up to 5 (default 3) resolved to current providerInstanceId and model. Explicit user choices come first; check catalog and quota. New releases inherit ranks; never pick legacy/supersededBy without a concrete reason. Edited only in Settings.",
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
