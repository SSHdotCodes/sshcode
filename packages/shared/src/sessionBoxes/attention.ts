import type { HashedLinearModel } from "./model.ts";
import { hashedLinearPredict } from "./model.ts";
import type { SessionBoxAttention } from "./taxonomy.ts";
import { featureWords } from "./text.ts";

/** Trained reply classifier, installed by `./models.ts` when present. */
export const sessionBoxAttentionModels: { reply: HashedLinearModel | null } = { reply: null };

/** Only the end of a reply decides what it asks: that's where agents put the ask. */
export const ATTENTION_TAIL_CHARS = 600;

export function replyTail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= ATTENTION_TAIL_CHARS
    ? trimmed
    : trimmed.slice(trimmed.length - ATTENTION_TAIL_CHARS);
}

/** Features for the reply classifier: words and pairs, with the last sentence marked. */
export function replyFeatures(text: string): string[] {
  const tail = replyTail(text);
  const sentences = tail.split(/(?<=[.!?])\s+|\n+/).filter((part) => part.trim().length > 0);
  const last = sentences.at(-1) ?? "";
  const features = ["bias", `endsq=${/\?\s*$/.test(tail)}`, `lastq=${last.includes("?")}`];
  const words = featureWords(tail);
  for (let index = 0; index < words.length; index++) {
    features.push(`w=${words[index]}`);
    if (index > 0) features.push(`b=${words[index - 1]}|${words[index]}`);
  }
  for (const word of featureWords(last)) features.push(`l=${word}`);
  // Repeated table rows and quoted phrases should not outweigh the final sentence.
  return [...new Set(features)];
}

const RULES: ReadonlyArray<readonly [SessionBoxAttention, RegExp]> = [
  [
    "blocked",
    /\b(i (couldn't|can't|cannot|wasn't able to)|blocked|need(s)? you to|please (run|sign in|log in|approve|plug|unlock|grant)|permission denied|requires your|waiting for you)\b/i,
  ],
  [
    "decision",
    /\b(want me to|should i|would you like|do you want|which (one|option)|prefer|shall i|let me know (if|whether|which))\b/i,
  ],
  [
    "progress",
    /\b(still running|in progress|i'll (check|report|follow up)|will (report|update)|waiting (for|on) (the|it|a)|running in the background)\b/i,
  ],
  [
    "review",
    /\b(take a look|have a look|review|screenshot|pull request|\bpr\b|diff|committed|installed|built|merged|ready (to|for))\b/i,
  ],
];

export function sessionBoxAttention(text: string): SessionBoxAttention {
  const tail = replyTail(text);
  if (tail.length === 0) return "done";
  const model = sessionBoxAttentionModels.reply;
  if (model) {
    // A short past-tense delivery report is unambiguous. In history, "installed"
    // also occurs in long progress reports, which can otherwise dominate the model.
    if (
      tail.length <= 180 &&
      /^(?:i\s+(?:have\s+)?|i['’]ve\s+)?(?:installed|built|committed|merged)\b/i.test(tail) &&
      !/\?|\b(?:still|waiting|next|will|needs?|please|couldn['’]t|can['’]t|cannot|failed|checking|running|progress|i['’]ll)\b/i.test(
        tail,
      )
    )
      return "review";
    const prediction = hashedLinearPredict<SessionBoxAttention>(model, replyFeatures(tail));
    if (prediction.probability >= 0.45) return prediction.label;
  }
  for (const [attention, pattern] of RULES) if (pattern.test(tail)) return attention;
  return /\?\s*$/.test(tail) ? "question" : "done";
}
