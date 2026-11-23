import { describe, expect, it } from "@effect/vitest";

import {
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { acpSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

const selection = (model: string, effort = "medium"): ModelSelection => ({
  instanceId: ProviderInstanceId.make("acp_test"),
  model,
  options: [{ id: "effort", value: effort }],
});

describe("acpSelectionTransition", () => {
  it("rejects model changes when the negotiated session cannot apply them", () => {
    expect(
      acpSelectionTransition({
        current: selection("old"),
        target: selection("new"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
      }).type,
    ).toBe("reject");
  });

  it("allows model changes when the negotiated session can apply them", () => {
    const sessionCapabilities: OrchestrationV2ProviderCapabilities = {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
      },
    };
    expect(
      acpSelectionTransition({
        current: selection("old"),
        target: selection("new"),
        sessionCapabilities,
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });

  it("allows option-only changes to be applied through ACP config options", () => {
    expect(
      acpSelectionTransition({
        current: selection("same", "medium"),
        target: selection("same", "high"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });

  it("starts a new session with a handoff when each model owns its session", () => {
    const sessionCapabilities: OrchestrationV2ProviderCapabilities = {
      ...AcpProviderCapabilitiesV2,
      sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
    };
    const owns = { modelOwnsSession: true };
    expect(
      acpSelectionTransition(
        {
          current: selection("custom:studio:deepseek-v4.1-flash-1017"),
          target: selection("custom:studio:inkling-2-mini"),
          sessionCapabilities,
        },
        owns,
      ),
    ).toEqual({ type: "create_with_handoff" });
    // The effort still changes in the running session.
    expect(
      acpSelectionTransition(
        {
          current: selection("custom:studio:inkling-2-mini", "high"),
          target: selection("custom:studio:inkling-2-mini", "low"),
          sessionCapabilities: AcpProviderCapabilitiesV2,
        },
        owns,
      ),
    ).toEqual({ type: "apply_on_next_turn" });
  });
});
