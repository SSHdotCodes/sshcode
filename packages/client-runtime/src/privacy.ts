/** Stable display aliases only. Never use these labels as persisted names or operation targets. */
export function privacyLabel(
  enabled: boolean,
  kind: "Chat" | "Project" | "Computer" | "Tab" | "Branch" | "Folder",
  identity: string,
  label: string,
): string {
  if (!enabled) return label;
  let hash = 2166136261;
  for (const character of `${kind}:${identity}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `${kind} ${(hash >>> 0).toString(36).padStart(7, "0")}`;
}
