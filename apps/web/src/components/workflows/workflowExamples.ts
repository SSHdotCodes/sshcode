import { sketchExampleWorkflow } from "@t3tools/shared/workflowSketch";
import type { WorkflowDefinition } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

export {
  SKETCH_HAIKU as HAIKU,
  SKETCH_OPUS as OPUS,
  SKETCH_SOL as SOL,
} from "@t3tools/shared/workflowSketch";

/** The user's sketch: Opus leads two Sol workers, each fanning out to many Haiku agents. */
export function exampleWorkflow(now: string, resolved: boolean): WorkflowDefinition {
  return sketchExampleWorkflow(now, resolved, () => randomUUID().replaceAll("-", "").slice(0, 12));
}
