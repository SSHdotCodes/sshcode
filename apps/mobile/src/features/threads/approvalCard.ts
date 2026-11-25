import type { ProviderApprovalOption, ProviderRequestKind } from "@t3tools/contracts";

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Allow until the agent restarts" },
  { decision: "decline", label: "Deny" },
] as const satisfies ReadonlyArray<ProviderApprovalOption>;

export interface ApprovalCardPresentation {
  /** One human title. The detail below is omitted when it would repeat this. */
  readonly title: string;
  /** App name, when the provider sent one and it is not already the title. */
  readonly appName: string | null;
  /** Command, path, or request text. Null when it repeats the title or app name. */
  readonly detail: string | null;
  readonly allow: ProviderApprovalOption | null;
  readonly deny: ProviderApprovalOption | null;
  /** Session allowances and anything else the provider offered, in source order. */
  readonly secondary: ReadonlyArray<ProviderApprovalOption>;
}

function approvalTitle(requestKind: ProviderRequestKind): string {
  switch (requestKind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "file-change":
      return "File change approval";
    case "permission":
      return "App permission approval";
    case "mcp-elicitation":
      return "App access approval";
  }
}

function distinctLine(value: string | undefined, taken: ReadonlyArray<string>): string | null {
  const text = value?.trim() ?? "";
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  return taken.some((entry) => entry.toLowerCase() === lower) ? null : text;
}

/**
 * What the approval card shows. Codex command approvals arrive with no options
 * and a raw request kind; the card still reads as one title plus Allow and Deny.
 */
export function presentApprovalCard(approval: {
  readonly requestKind: ProviderRequestKind;
  readonly appName?: string | undefined;
  readonly detail?: string | undefined;
  readonly options?: ReadonlyArray<ProviderApprovalOption> | undefined;
}): ApprovalCardPresentation {
  const title = approvalTitle(approval.requestKind);
  const appName = distinctLine(approval.appName, [title]);
  const detail = distinctLine(approval.detail, appName === null ? [title] : [title, appName]);
  const options = approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  return {
    title,
    appName,
    detail,
    allow: options.find((option) => option.decision === "accept") ?? null,
    deny: options.find((option) => option.decision === "decline") ?? null,
    secondary: options.filter(
      (option) => option.decision !== "accept" && option.decision !== "decline",
    ),
  };
}
