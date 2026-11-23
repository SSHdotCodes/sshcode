import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ScheduledTaskState from "./ScheduledTaskState.ts";
export const layer = ScheduledTaskState.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-task-state-test-" })),
  Layer.provide(NodeServices.layer),
);
