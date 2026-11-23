import type {
  OrchestrationV2ThreadProjection,
  OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";
import { ProviderRequestKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const approvalKind = Schema.is(ProviderRequestKind);

/** The cockpit needs only a discriminator, without reading request text or turn items. */
export function pendingTaskNeeds(projection: {
  readonly runtimeRequests: ReadonlyArray<{ readonly kind: string; readonly status: string }>;
}): "approval" | "input" | undefined {
  let input = false;
  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    if (approvalKind(request.kind)) return "approval";
    if (request.kind === "user_input") input = true;
  }
  return input ? "input" : undefined;
}

/** Compact handles only; full questions and permission-checked responses stay in the request tools. */
export function pendingTaskRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): NonNullable<OrchestratorMcpDelegateTaskResult["pendingRequests"]> {
  return projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .map((request) => {
      const item = projection.turnItems.find(
        (item) =>
          (item.type === "user_input_request" || item.type === "approval_request") &&
          item.requestId === request.id,
      );
      const label =
        item?.type === "user_input_request"
          ? (item.questions[0]?.header ?? item.title ?? request.kind)
          : (item?.title ?? request.kind);
      return { id: request.id, kind: request.kind, label: label.slice(0, 80) };
    });
}
