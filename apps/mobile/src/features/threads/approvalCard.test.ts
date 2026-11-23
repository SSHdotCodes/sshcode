import { describe, expect, it } from "vite-plus/test";

import { presentApprovalCard } from "./approvalCard";

describe("presentApprovalCard", () => {
  it("keeps the full multiline permission scope", () => {
    const detail =
      'Working directory: "/work"\n\nRequested permissions:\n{\n  "read": ["/work/a"],\n  "network": true\n}';
    expect(presentApprovalCard({ requestKind: "file-read", detail }).detail).toBe(detail);
  });
  it("names a command approval once and offers Allow and Deny", () => {
    const card = presentApprovalCard({
      requestKind: "command",
      detail: "rm -rf /tmp/build",
    });

    expect(card.title).toBe("Command approval");
    expect(card.detail).toBe("rm -rf /tmp/build");
    expect(card.appName).toBeNull();
    expect(card.allow?.label).toBe("Allow");
    expect(card.deny?.label).toBe("Deny");
    expect(card.secondary.map((option) => option.label)).toEqual(["Allow for this session"]);
    expect(`${card.title}\n${card.detail}`).not.toContain("Command approval requested");
  });

  it("drops a detail that only repeats the title", () => {
    const card = presentApprovalCard({
      requestKind: "file-read",
      detail: "File read approval",
    });

    expect(card.title).toBe("File read approval");
    expect(card.detail).toBeNull();
  });

  it("shows an app access request's name and message once each", () => {
    const card = presentApprovalCard({
      requestKind: "mcp-elicitation",
      appName: "Safari",
      detail: "Allow ChatGPT to use Safari?",
    });

    expect(card.title).toBe("App access approval");
    expect(card.appName).toBe("Safari");
    expect(card.detail).toBe("Allow ChatGPT to use Safari?");
  });

  it("keeps provider option labels and puts only Allow and Deny in the primary pair", () => {
    const card = presentApprovalCard({
      requestKind: "permission",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "acceptForSession", label: "Always allow" },
        { decision: "decline", label: "Reject" },
        { decision: "accept", label: "Approve once" },
      ],
    });

    expect(card.allow?.label).toBe("Approve once");
    expect(card.deny?.label).toBe("Reject");
    expect(card.secondary.map((option) => option.decision)).toEqual(["cancel", "acceptForSession"]);
  });
});
