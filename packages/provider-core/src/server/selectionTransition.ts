import type { ModelSelection, OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";

export interface ProviderSelectionTransitionInput {
  readonly current: ModelSelection;
  readonly target: ModelSelection;
  readonly sessionCapabilities: OrchestrationV2ProviderCapabilities;
}

/**
 * Provider-owned classification of how a complete selection can be applied.
 * The orchestrator remains responsible for attempts and resource lifecycle.
 */
export type ProviderSelectionTransitionPlan =
  | { readonly type: "apply_on_next_turn" }
  | { readonly type: "restart_session" }
  | { readonly type: "create_with_handoff" }
  | { readonly type: "reject"; readonly reason: string };

export function turnScopedSelectionTransition(): ProviderSelectionTransitionPlan {
  return { type: "apply_on_next_turn" };
}

/**
 * ACP models require a negotiated model/config mutation capability. Where each model runs in
 * a session of its own (`modelOwnsSession`: one home and endpoint per model),
 * another model starts a new session with the conversation handed over; options such as the
 * effort still change in place.
 */
export function acpSelectionTransition(
  input: ProviderSelectionTransitionInput,
  options?: { readonly modelOwnsSession?: boolean },
): ProviderSelectionTransitionPlan {
  if (options?.modelOwnsSession === true && input.current.model !== input.target.model) {
    return { type: "create_with_handoff" };
  }
  if (
    input.current.model !== input.target.model &&
    !input.sessionCapabilities.sessions.supportsModelSwitchInSession
  ) {
    return {
      type: "reject",
      reason: "The active ACP session does not expose a model-switch capability.",
    };
  }
  return { type: "apply_on_next_turn" };
}
