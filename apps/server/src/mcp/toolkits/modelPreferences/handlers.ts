import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ModelPreferences from "../../../provider/ModelPreferences.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ModelPreferencesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ModelPreferencesToolkit, {
  model_preferences: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("orchestration"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot read model preferences.",
        });
      const preferences = yield* ModelPreferences.ModelPreferences;
      return yield* preferences.lookup(input).pipe(Effect.mapError(unavailable));
    }),
  ),
});
