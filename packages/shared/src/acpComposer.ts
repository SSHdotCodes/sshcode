import type {
  ProviderOptionChoice,
  ProviderOptionDescriptor,
  RuntimeMode,
  SelectProviderOptionDescriptor,
} from "@t3tools/contracts";

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const matches = (choice: ProviderOptionChoice, names: ReadonlyArray<string>) =>
  names.includes(normalize(choice.id)) || names.includes(normalize(choice.label));

export const ACP_SESSION_MODE_OPTION_ID = "_t3/session-mode";

export function acpApprovalModes(descriptor: ProviderOptionDescriptor) {
  if (
    descriptor.type !== "select" ||
    descriptor.role === "reasoning" ||
    (!descriptor.acpSessionMode &&
      descriptor.id !== ACP_SESSION_MODE_OPTION_ID &&
      !["mode", "sessionmode"].includes(normalize(descriptor.id)))
  ) {
    return null;
  }
  const find = (...names: string[]) => descriptor.options.find((choice) => matches(choice, names));
  const bypass = find("bypasspermissions", "yolo", "fullaccess", "unrestricted", "alwaysallow");
  const automatic = find("auto", "smart", "autopilot", "approvesafe");
  const autoEdits = find("autoedit", "acceptedit", "acceptedits", "autoacceptedits");
  // Devin's Code and Ask are both work modes. Only Code participates in its
  // Code / Smart / Bypass Permissions approval scale.
  const devinShape = find("code") && find("smart") && find("bypasspermissions");
  const supervised = devinShape
    ? find("code")
    : find("default", "approvalrequired", "supervised", "askalways", "askbeforechanges", "manual");
  if (!supervised || (!automatic && !autoEdits && !bypass)) return null;
  const automaticChoice = automatic ?? autoEdits;
  const approvals: Partial<Record<RuntimeMode, ProviderOptionChoice>> = {
    "approval-required": supervised,
    ...(automaticChoice ? { auto: automaticChoice } : {}),
    ...(automatic && autoEdits ? { "auto-accept-edits": autoEdits } : {}),
    ...(bypass ? { "full-access": bypass } : {}),
  };
  const workModes = [
    supervised,
    ...descriptor.options.filter((choice) => !Object.values(approvals).includes(choice)),
  ];
  return {
    descriptor,
    approvals,
    workModes,
    plan: workModes.find((choice) => matches(choice, ["plan", "architect"])),
  };
}

export function findAcpApprovalModes(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  for (const descriptor of descriptors) {
    const modes = acpApprovalModes(descriptor);
    if (modes) return modes;
  }
  return null;
}

export function acpWorkModeDescriptor(
  modes: NonNullable<ReturnType<typeof acpApprovalModes>>,
  interactionMode: "default" | "plan",
): SelectProviderOptionDescriptor {
  const selected = modes.workModes.find((choice) => choice.id === modes.descriptor.currentValue);
  const current = interactionMode === "plan" ? modes.plan : selected;
  return {
    ...modes.descriptor,
    label: "Work mode",
    currentValue: current?.id ?? modes.workModes[0]!.id,
    options: modes.workModes,
  };
}

export function acpSpeedIcon(choice: ProviderOptionChoice): "fast" | "ultrafast" | null {
  if (matches(choice, ["ultrafast", "lightning"])) return "ultrafast";
  return matches(choice, ["fast", "turbo"]) ? "fast" : null;
}

export function acpSpeedChoices(descriptor: ProviderOptionDescriptor) {
  if (
    descriptor.type !== "select" ||
    !["speed", "speedmode", "inferencespeed"].some(
      (name) => name === normalize(descriptor.id) || name === normalize(descriptor.label),
    )
  ) {
    return null;
  }
  const on = descriptor.options.find((choice) => acpSpeedIcon(choice) !== null);
  if (!on || descriptor.options.length < 2) return null;
  const off =
    descriptor.options.find((choice) =>
      matches(choice, ["standard", "normal", "default", "off"]),
    ) ?? descriptor.options.find((choice) => acpSpeedIcon(choice) === null);
  return off ? { on, off } : null;
}
