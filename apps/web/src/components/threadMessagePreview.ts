import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export function threadMessagePreview(
  message: Pick<
    NonNullable<OrchestrationV2ThreadShell["latestVisibleMessage"]>,
    "role" | "text"
  > | null,
): { readonly label: string; readonly text: string } | null {
  const text = message?.text.trim().replace(/\s+/g, " ");
  if (!message || !text) return null;
  return {
    label: message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "System",
    text: text.length > 480 ? `${text.slice(0, 480).trimEnd()}…` : text,
  };
}
