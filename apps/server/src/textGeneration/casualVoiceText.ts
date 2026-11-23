import { hasCasualVoiceDecoration } from "@t3tools/shared/casualVoice";
export function selectStyleExamples(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly senderThreadId?: unknown;
    readonly questionAnswer?: unknown;
    readonly id?: string;
  }>,
) {
  const selected: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const message of messages.toReversed()) {
    const text = message.text.trim();
    const key = text.toLowerCase();
    if (
      message.role !== "user" ||
      message.senderThreadId ||
      message.questionAnswer ||
      message.id?.startsWith("async-answer:") ||
      text.length < 3 ||
      text.length > 240 ||
      seen.has(key) ||
      hasCasualVoiceDecoration(text)
    )
      continue;
    if (
      /(?:secret|token|password|passwd|api.?key|authorization|bearer|private.key|sk-|gh[pousr]_|AKIA|BEGIN.*KEY)|[A-Za-z0-9_+/=-]{24,}|https?:|[~/]\w|[A-Za-z]:\\|[`{};<>]|\b(?:const|import|export|function|sudo|ssh|curl|npm|pnpm|git)\b/i.test(
        text,
      )
    )
      continue;
    if (text.split("\n").length > 3 || length + text.length > 4800) continue;
    seen.add(key);
    selected.push(text);
    length += text.length;
    if (selected.length === 32) break;
  }
  return selected.toReversed();
}
