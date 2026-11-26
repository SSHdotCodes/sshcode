import { describe, expect, it } from "@effect/vitest";
import type { ProviderOptionChoice, SelectProviderOptionDescriptor } from "@t3tools/contracts";
import {
  acpApprovalModes,
  acpSpeedChoices,
  acpSpeedIcon,
  acpWorkModeDescriptor,
} from "./acpComposer.ts";

const select = (
  id: string,
  options: ReadonlyArray<ProviderOptionChoice>,
  currentValue: string,
): SelectProviderOptionDescriptor => ({ id, label: id, type: "select", options, currentValue });

describe("ACP composer options", () => {
  it("keeps Devin Ask and Plan in work modes and retains the approval choice descriptions", () => {
    const code = { id: "code", label: "Code", description: "Write and edit code" };
    const smart = { id: "smart", label: "Smart", description: "Auto-approve safe actions" };
    const ask = { id: "ask", label: "Ask" };
    const plan = { id: "plan", label: "Plan" };
    const bypass = { id: "bypassPermissions", label: "Bypass Permissions" };
    const modes = acpApprovalModes(select("mode", [code, smart, ask, plan, bypass], "smart"));

    expect(modes?.approvals).toEqual({
      "approval-required": code,
      auto: smart,
      "full-access": bypass,
    });
    expect(modes?.workModes).toEqual([code, ask, plan]);
    expect(acpWorkModeDescriptor(modes!, "default").currentValue).toBe("code");
    expect(acpWorkModeDescriptor(modes!, "plan").currentValue).toBe("plan");
  });

  it("maps an opaque mode id and mixed-case approval values without a provider name", () => {
    const choices = [
      { id: "one", label: "Default" },
      { id: "auto_edit", label: "Auto Edit" },
      { id: "YOLO", label: "YOLO" },
    ];
    const modes = acpApprovalModes({
      ...select("config-42", choices, "one"),
      acpSessionMode: true,
    });
    expect(modes?.approvals).toEqual({
      "approval-required": choices[0],
      auto: choices[1],
      "full-access": choices[2],
    });
    expect(modes?.workModes).toEqual([choices[0]]);
  });

  it("leaves ordinary code, ask, and architect modes intact", () => {
    const choices = ["code", "ask", "architect"].map((id) => ({ id, label: id }));
    expect(acpApprovalModes(select("_t3/session-mode", choices, "code"))).toBeNull();
  });

  it("does not interpret reasoning or unrelated config as an approval scale", () => {
    const choices = ["default", "auto", "yolo"].map((id) => ({ id, label: id }));
    expect(acpApprovalModes(select("strategy", choices, "default"))).toBeNull();
    expect(
      acpApprovalModes({ ...select("mode", choices, "default"), role: "reasoning" }),
    ).toBeNull();
  });

  it("retains native speed values and maps Lightning and Ultrafast to the ultrafast bolt", () => {
    const normal = { id: "regular", label: "Standard" };
    const lightning = { id: "fast", label: "Lightning" };
    const fast = { id: "quick", label: "Fast" };
    const descriptor = select("inference_speed", [normal, lightning, fast], "regular");
    expect(acpSpeedChoices(descriptor)).toEqual({ off: normal, on: lightning });
    expect(acpSpeedIcon(lightning)).toBe("ultrafast");
    expect(acpSpeedIcon({ id: "fast", label: "Ultrafast" })).toBe("ultrafast");
    expect(acpSpeedIcon(fast)).toBe("fast");
    expect(acpSpeedChoices(select("reasoning", [normal, lightning], "regular"))).toBeNull();
  });
});
