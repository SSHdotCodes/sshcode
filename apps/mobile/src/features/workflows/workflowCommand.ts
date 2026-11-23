/** A whole leading command, never a substring of a normal message. */
export function workflowCommand(text: string, beta: boolean): string | null {
  if (!beta || !/^\/workflow(?:\s|$)/iu.test(text)) return null;
  return text.replace(/^\/workflow\s*/iu, "");
}
