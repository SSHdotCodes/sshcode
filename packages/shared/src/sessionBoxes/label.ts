import type { HashedLinearModel } from "./model.ts";
import { hashedLinearPredict, hashedLinearScores } from "./model.ts";
import type { SessionBoxTopic } from "./taxonomy.ts";
import { cleanSessionTitle, featureWords, type TitleToken, tokenizeTitle } from "./text.ts";

/**
 * Trained models, installed by `./models.ts`. Rules decide when weights are absent or
 * the topic model's confidence is below the validation-selected threshold.
 */
export const sessionBoxLabelModels: {
  keep: HashedLinearModel | null;
  topic: HashedLinearModel | null;
} = { keep: null, topic: null };

export interface SessionBoxName {
  /** One to three words that tell this chat apart, as written in the title. */
  readonly label: string;
  readonly topic: SessionBoxTopic;
  /** False for placeholder titles ("Start a conversation"): the box shows its topic instead. */
  readonly meaningful: boolean;
}

const GENERIC_TITLES = new Set([
  "start a conversation",
  "new chat",
  "new thread",
  "new session",
  "greeting",
  "hello",
  "hi",
  "untitled",
  "chat",
  "conversation",
]);

const STOPWORDS = new Set(
  "a an the and or of for to in on at by with from into via vs is are be my your our this that it its as up out about how what why when which who".split(
    " ",
  ),
);

/** Leading verbs carry the topic, not the identity: "Fix Cove Video Playback" → "Cove Video". */
const LEADING_VERBS = new Set(
  "add benchmark build check clean compare free create debug deploy distill estimate explain find fix get help identify implement improve install investigate make move open review run set setup show sideload start streamline test train transcribe troubleshoot try uninstall update use write assess boost".split(
    " ",
  ),
);

const MAX_LABEL_CHARS = 36;
// Calibrated on held-out validation titles, after the three-word/24-character decoder.
const KEEP_MODEL_MIN_SCORE = -0.5;

export interface SessionBoxLabelContext {
  /**
   * Other titles shown beside this one. Words most of them share ("acme ·") don't
   * tell boxes apart, so they are dropped from the label.
   */
  readonly siblingTitles?: ReadonlyArray<string>;
  /** `siblingWordShare(siblingTitles)`, when the caller labels many boxes at once. */
  readonly siblingShare?: ReadonlyMap<string, number>;
  /** Room for the label; small boxes fit about 16 characters on two lines. */
  readonly maxChars?: number;
}

/** Shared document frequency of normalized words across sibling titles. */
export function siblingWordShare(titles: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const word of new Set(tokenizeTitle(title).map((token) => token.norm))) {
      if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const share = new Map<string, number>();
  for (const [word, count] of counts) share.set(word, count / Math.max(1, titles.length));
  return share;
}

function tokenShape(text: string): string {
  if (/^\d+([.,]\d+)*$/.test(text)) return "num";
  if (/\d/.test(text)) return "alnum";
  if (/^\p{Lu}{2,}$/u.test(text)) return "caps";
  if (/^\p{Lu}/u.test(text)) return "cap";
  if (/^[^\p{L}\p{N}]+$/u.test(text)) return "punct";
  return "lower";
}

/** Features for "keep this word in the label", shared by training and inference. */
export function labelTokenFeatures(tokens: ReadonlyArray<TitleToken>, index: number): string[] {
  const token = tokens[index]!;
  const previous = tokens[index - 1]?.norm ?? "<s>";
  const next = tokens[index + 1]?.norm ?? "</s>";
  const fromEnd = tokens.length - 1 - index;
  return [
    `w=${token.norm}`,
    `shape=${tokenShape(token.text)}`,
    `pos=${Math.min(index, 6)}`,
    `end=${Math.min(fromEnd, 6)}`,
    `len=${Math.min(token.norm.length, 12)}`,
    `prev=${previous}`,
    `next=${next}`,
    `prev+w=${previous}|${token.norm}`,
    `w+next=${token.norm}|${next}`,
    `stop=${STOPWORDS.has(token.norm)}`,
    `verb0=${index === 0 && LEADING_VERBS.has(token.norm)}`,
    `n=${Math.min(tokens.length, 10)}`,
    "bias",
  ];
}

/** Features for the topic classifier: words, word pairs and a few character n-grams. */
export function topicFeatures(text: string): string[] {
  const words = featureWords(cleanSessionTitle(text));
  const features = ["bias"];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    features.push(`w=${word}`);
    if (index > 0) features.push(`b=${words[index - 1]}|${word}`);
    if (word.length > 4) features.push(`p=${word.slice(0, 4)}`);
  }
  return features;
}

const TOPIC_RULES: ReadonlyArray<readonly [SessionBoxTopic, RegExp]> = [
  ["cleanup", /\b(free up|clean ?up|junk|disk space|storage|declutter)\b/i],
  ["benchmark", /\b(benchmark|bench|speed|latency|throughput|load test|eval(s|uate|uation)?)\b/i],
  ["training", /\b(train(ing)?|fine-?tune|distill|lora|dataset|checkpoint|head)\b/i],
  ["bug", /\b(fix|bug|crash|broken|error|troubleshoot|debug|issue|not working|messed up)\b/i],
  ["review", /\b(review|audit|critic|diff|code review)\b/i],
  ["mobile", /\b(iphone|ipad|ios|android|mobile|sideload|testflight|xcode)\b/i],
  ["website", /\b(website|site|web ?page|landing|blog|homepage|ssh\.codes|404)\b/i],
  ["network", /\b(wi-?fi|hotspot|network|vpn|dns|tailscale|router|ssh)\b/i],
  ["devices", /\b(printer|cd reader|usb|raspberry|pi\b|keyboard|monitor|drive)\b/i],
  ["gpu", /\b(gpu|cuda|kernel|vram|rtx|blackwell|nvidia)\b/i],
  ["model", /\b(llm|model|gpt|claude|grok|deepseek|qwen|gemma|prompt|inference)\b/i],
  ["server", /\b(server|deploy|hosting|backend|service|workstation)\b/i],
  ["security", /\b(key|password|auth|login|security|vault|permission|token)\b/i],
  ["data", /\b(download(s)?|stats|statistics|analytics|spreadsheet|database|data)\b/i],
  ["media", /\b(image|video|audio|transcri\w*|voice|photo|3d|playback|picture)\b/i],
  ["design", /\b(design|ui|ux|animation|style|icon|art|theme|redesign)\b/i],
  ["science", /\b(simulation|physics|black hole|math|scientific)\b/i],
  ["bot", /\b(bot|discord|rpc|scraper|automation)\b/i],
  ["agents", /\b(agent(s)?|harness|subagent|orchestrat\w*|codex|t3 ?code|sshcode)\b/i],
  ["money", /\b(cost|price|pricing|subscription|usage|billing|token usage)\b/i],
  ["test", /\b(test(s|ing)?|qa|verify|spot-check)\b/i],
  ["build", /\b(build|release|install|package|ship)\b/i],
  ["settings", /\b(setup|set up|config\w*|settings|uninstall)\b/i],
  ["writing", /\b(write|writing|docs?|readme|post|email|article|copy)\b/i],
  ["research", /\b(research|compare|find|identify|investigate|assess|explore|estimate)\b/i],
  ["question", /\b(meaning|what is|why|how do|explain|\?)/i],
  ["app", /\b(app|feature|screen|sidebar|composer|console)\b/i],
];

function ruleTopic(title: string): SessionBoxTopic | null {
  for (const [topic, pattern] of TOPIC_RULES) if (pattern.test(title)) return topic;
  return null;
}

export function sessionBoxTopic(title: string): SessionBoxTopic {
  const cleaned = cleanSessionTitle(title);
  if (cleaned.length === 0 || GENERIC_TITLES.has(cleaned.toLowerCase().replace(/[.!]+$/, "")))
    return "general";
  const model = sessionBoxLabelModels.topic;
  if (model) {
    const prediction = hashedLinearPredict<SessionBoxTopic>(model, topicFeatures(title));
    if (prediction.probability >= 0.35) return prediction.label;
  }
  return ruleTopic(title) ?? "general";
}

function keepScores(tokens: ReadonlyArray<TitleToken>): number[] {
  const model = sessionBoxLabelModels.keep;
  return tokens.map((token, index) => {
    if (!token.norm) return -10;
    if (model) {
      const [drop = 0, keep = 0] = hashedLinearScores(model, labelTokenFeatures(tokens, index));
      return keep - drop;
    }
    // Rules: proper nouns, numbers and product names identify a chat; small words don't.
    if (STOPWORDS.has(token.norm)) return -3;
    if (index === 0 && LEADING_VERBS.has(token.norm) && tokens.length > 2) return -1.5;
    const shape = tokenShape(token.text);
    const base = shape === "cap" || shape === "caps" || shape === "alnum" ? 1.2 : 0.6;
    // Earlier words usually name the subject; later ones qualify it.
    return base - index * 0.08;
  });
}

/**
 * The name a box shows: the title's own words in its order, minus filler, shortened to
 * about two lines by dropping the weakest words and those most sibling titles share.
 */
export function sessionBoxName(
  title: string,
  context: SessionBoxLabelContext = {},
): SessionBoxName {
  const cleaned = cleanSessionTitle(title);
  if (cleaned.length === 0 || GENERIC_TITLES.has(cleaned.toLowerCase().replace(/[.!]+$/, ""))) {
    return { label: "", topic: "general", meaningful: false };
  }
  const topic = sessionBoxTopic(cleaned);
  const tokens = tokenizeTitle(cleaned);
  const share =
    context.siblingShare ??
    (context.siblingTitles && context.siblingTitles.length >= 3
      ? siblingWordShare(context.siblingTitles)
      : null);
  const keep = keepScores(tokens);
  const scores = keep.map((score, index) => {
    const shared = share?.get(tokens[index]!.norm) ?? 0;
    // A word on most boxes names the group, not this box: it goes first when space is short.
    return shared >= 0.4 ? score - 4 * shared : score;
  });
  const maxChars = context.maxChars ?? MAX_LABEL_CHARS;
  // A title that fits is the most recognizable name there is.
  if (cleaned.length <= maxChars) return { label: cleaned, topic, meaningful: true };
  const minScore = sessionBoxLabelModels.keep ? KEEP_MODEL_MIN_SCORE : -2.5;
  // Start from the title itself, in its own order, without filler; then drop the weakest
  // words, shared ones first, until it fits about two lines. A name close to the title is
  // what makes a box as easy to find as a row.
  let kept = tokens
    .map((token, index) => ({ token, index, score: scores[index]! }))
    .filter((entry) => entry.token.norm.length > 0 && keep[entry.index]! > minScore);
  kept = fitWords(kept, maxChars);
  if (kept.length === 0 && sessionBoxLabelModels.keep) {
    const best = tokens
      .map((token, index) => ({ token, index, score: scores[index]! }))
      .filter((entry) => entry.token.norm.length > 0)
      // A copied sort, not toSorted(): Hermes on iPhone lacks the ES2023 method.
      .sort((left, right) => right.score - left.score)[0];
    return best
      ? { label: tidyLabel(best.token.text), topic, meaningful: true }
      : { label: "", topic, meaningful: false };
  }
  if (kept.length === 0) return { label: cleaned.slice(0, maxChars), topic, meaningful: true };
  const label = kept.map((entry) => entry.token.text).join(" ");
  return { label: tidyLabel(label), topic, meaningful: true };
}

interface ScoredWord {
  readonly token: TitleToken;
  readonly index: number;
  readonly score: number;
}

/** Drops the weakest words, keeping the rest in order, until they fit `maxChars`. */
function fitWords(words: ReadonlyArray<ScoredWord>, maxChars: number): ScoredWord[] {
  let kept = [...words];
  const width = () =>
    kept.reduce((sum, word, index) => sum + word.token.text.length + (index > 0 ? 1 : 0), 0);
  while (kept.length > 1 && width() > maxChars) {
    let weakest = 0;
    for (let index = 1; index < kept.length; index++)
      if (kept[index]!.score <= kept[weakest]!.score) weakest = index;
    kept = kept.filter((_, index) => index !== weakest);
  }
  return kept;
}

const NOW_MAX_CHARS = 60;

/** Openers that carry no meaning of their own: "and", "so", "can you", "please"… */
const REQUEST_FILLER =
  /^(?:(?:and|so|ok|okay|also|but|hey|hi|wait|please|pls|now|then|just|maybe|actually|alright|great|thanks|cool|yes|yeah|no|nice|(?:can|could|would|will)\s+(?:you|u)|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to|let'?s)\b[\s,.!:-]*)+/iu;

/** Content words: what overlap with the title is measured on. */
function contentWords(text: string): string[] {
  return tokenizeTitle(text)
    .map((token) => token.norm)
    .filter((norm) => norm.length >= 3 && !STOPWORDS.has(norm));
}

/**
 * Whether two short descriptions of a chat's work name the same topic: at least half the
 * content words of the shorter one appear in the other.
 */
export function sameSessionTopic(left: string, right: string): boolean {
  const leftWords = new Set(contentWords(left));
  const rightWords = new Set(contentWords(right));
  if (leftWords.size === 0 || rightWords.size === 0) return false;
  const shared = [...rightWords].filter((word) => leftWords.has(word)).length;
  return shared * 2 >= Math.min(leftWords.size, rightWords.size);
}

/**
 * What a chat is on now: the opening of the user's latest request, in their own words,
 * for a chat that has moved on from its title. Null when the request says too little
 * ("yes, do it") or mostly repeats the title.
 */
export function sessionBoxNow(request: string, title: string): string | null {
  // The first line or sentence carries the ask; the rest is detail.
  const first =
    request
      .slice(0, 400)
      .split(/\n|(?<=[.?!])\s/)
      .map((part) => cleanSessionTitle(part).replace(REQUEST_FILLER, "").trim())
      .find((part) => part.length > 0) ?? "";
  const words = contentWords(first).slice(0, 8);
  if (words.length < 2) return null;
  const titleWords = new Set(contentWords(title));
  const repeated = words.filter((word) => titleWords.has(word)).length;
  if (repeated * 2 >= words.length) return null;
  let text = first;
  if (text.length > NOW_MAX_CHARS) {
    const cut = text.lastIndexOf(" ", NOW_MAX_CHARS);
    text = `${text.slice(0, cut > 20 ? cut : NOW_MAX_CHARS).replace(/[\s,;:–—-]+$/u, "")}…`;
  }
  return text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Picked words can carry punctuation that only made sense in the full title: a trailing
 * comma, or one half of "(Mac + iPhone)". A plain lowercase first word is capitalized,
 * so "loading iPhone" reads "Loading iPhone" but "iPhone" and "w2" stay as written.
 */
function tidyLabel(label: string): string {
  let text = label.replace(/[,;:·—|]+(?=\s|$)/gu, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    if (text.split(open).length !== text.split(close).length)
      text = text.replaceAll(open, "").replaceAll(close, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  return /^[a-z]+(?:[\s-]|$)/.test(text) ? text[0]!.toUpperCase() + text.slice(1) : text;
}
