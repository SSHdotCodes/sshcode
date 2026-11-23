/** UTF-8 content bytes, with a stable estimate rather than a provider tokenizer. */
export const byteCount = (text: string) => Buffer.byteLength(text, "utf8");
export const volume = (bytes: number) => ({ bytes, estimatedTokens: Math.ceil(bytes / 4) });

/** Quantify repeated catalog metadata without emitting its text. */
export function auditToolSchemas(
  tools: readonly { inputSchema: unknown; outputSchema?: unknown }[],
) {
  const descriptions = new Set<string>();
  const outputs = new Set<string>();
  let descriptionBytes = 0;
  let repeatedDescriptionBytes = 0;
  let repeatedOutputSchemaBytes = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const item = value as Record<string, unknown>;
    if (typeof item.description === "string") {
      const bytes = byteCount(item.description);
      descriptionBytes += bytes;
      if (descriptions.has(item.description)) repeatedDescriptionBytes += bytes;
      descriptions.add(item.description);
    }
    Object.values(item).forEach(visit);
  };
  for (const tool of tools) {
    visit(tool.inputSchema);
    visit(tool.outputSchema);
    if (tool.outputSchema == null) continue;
    const encoded = JSON.stringify(tool.outputSchema);
    if (outputs.has(encoded)) repeatedOutputSchemaBytes += byteCount(encoded);
    outputs.add(encoded);
  }
  return { descriptionBytes, repeatedDescriptionBytes, repeatedOutputSchemaBytes };
}

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const categories = [
  "instructions",
  "prompts",
  "toolSchemas",
  "toolResults",
  "wakes",
  "notifications",
] as const;
type Category = (typeof categories)[number];
type Part = { category: Category; text: string };

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  const item = record(value);
  if (typeof item.text === "string") return [item.text];
  if (typeof item.value === "string") return [item.value];
  return [];
}

/** Only content fields, never host paths, auth, images, transport IDs or permission metadata. */
function frameParts(value: unknown): Part[] {
  const frame = record(value);
  const params = record(frame.params ?? frame.input);
  const type = frame.method ?? frame.type;
  const parts: Part[] = [];
  const add = (category: Category, content: unknown) => {
    for (const text of textParts(content)) if (text.length > 0) parts.push({ category, text });
  };
  const options = record(frame.options);
  add(
    "instructions",
    typeof options.systemPrompt === "string"
      ? options.systemPrompt
      : record(options.systemPrompt).append,
  );
  add("instructions", params.developerInstructions);
  add("instructions", record(record(params.collaborationMode).settings).developer_instructions);
  add("instructions", params.system);
  add("instructions", params.customInstructions);
  for (const context of Object.values(record(params.additionalContext)))
    add("instructions", context);
  if (type === "session.instructions.entry.put") add("instructions", params.value);
  if (type === "prompt.offer") add("prompts", record(record(frame.message).message).content);
  if (type === "run.start" || type === "prompt") add("prompts", frame.message);
  if (type === "turn/start" || type === "turn/steer") add("prompts", params.input);
  if (type === "session/prompt") add("prompts", params.prompt);
  if (type === "session.promptAsync") add("prompts", params.parts);
  if (type === "session.prompt" || type === "session.synthetic" || type === "session.command")
    add("prompts", params.text);
  // Explicit app replies to provider tool requests, when a fixture exercises one.
  if (frame.result !== undefined) {
    const result = record(frame.result);
    if (result.content !== undefined) add("toolResults", result.content);
  }
  return parts.flatMap((part) => {
    if (part.category !== "prompts") return [part];
    // ACP and Cursor mix app instructions into the prompt. Count each byte once.
    const instructionBlocks =
      /<t3_code_(?:orchestration_)?instructions>[\s\S]*?<\/t3_code_(?:orchestration_)?instructions>|<runtime_info>[\s\S]*?<\/runtime_info>/g;
    const instructions = [...part.text.matchAll(instructionBlocks)].map(([text]) => ({
      category: "instructions" as const,
      text,
    }));
    const rest = part.text.replace(instructionBlocks, "");
    return [
      ...instructions,
      ...(rest.length === 0 ? [] : [{ category: "prompts" as const, text: rest }]),
    ];
  });
}

/** One collector per replay; content stays in memory and artifacts contain numbers only. */
export function makeQualityCollector() {
  const sends: Part[][] = [];
  return {
    observe: (frame: unknown) => {
      const parts = frameParts(frame);
      if (parts.length === 0) return;
      sends.push(parts);
    },
    snapshot: (messages: { wakes?: readonly string[]; notifications?: readonly string[] } = {}) => {
      const bytes = Object.fromEntries(categories.map((key) => [key, 0])) as Record<
        Category,
        number
      >;
      const seen = new Set<string>();
      let repeatedParts = 0;
      let repeatedBytes = 0;
      for (const source of sends.flat()) {
        const payload = source.text
          .trim()
          .replace(/^<user_request>\s*([\s\S]*?)\s*<\/user_request>$/, "$1")
          .trim();
        const matches = (text: string) => text.trim().length > 0 && payload === text.trim();
        const category =
          (source.category === "prompts" || source.category === "notifications") &&
          messages.wakes?.some(matches)
            ? "wakes"
            : source.category === "prompts" && messages.notifications?.some(matches)
              ? "notifications"
              : source.category;
        const part = { ...source, category };
        const size = byteCount(part.text);
        bytes[part.category] += size;
        const key = `${part.category}:${part.text}`;
        if (seen.has(key)) {
          repeatedParts++;
          repeatedBytes += size;
        }
        seen.add(key);
      }
      return {
        content: Object.fromEntries(categories.map((key) => [key, volume(bytes[key])])),
        total: volume(Object.values(bytes).reduce((a, b) => a + b, 0)),
        contentSends: sends.length,
        repeatedParts,
        repeated: volume(repeatedBytes),
      };
    },
  };
}

export interface Regression {
  path: string;
  before: number | null;
  after: number | null;
}

export function metricChanges(baseline: unknown, current: unknown) {
  const changes: {
    path: string;
    before: number;
    after: number;
    delta: number;
    percent: number | null;
  }[] = [];
  const visit = (before: unknown, after: unknown, path: string) => {
    if (
      typeof before === "number" &&
      typeof after === "number" &&
      Number.isFinite(before) &&
      Number.isFinite(after)
    ) {
      if (before !== after)
        changes.push({
          path,
          before,
          after,
          delta: after - before,
          percent: before === 0 ? null : ((after - before) / before) * 100,
        });
      return;
    }
    for (const [key, value] of Object.entries(record(before)))
      visit(value, record(after)[key], path ? `${path}.${key}` : key);
  };
  visit(baseline, current, "");
  return changes;
}

/** Gate every numeric leaf independently, including zero baselines and deleted coverage. */
export function compareMetrics(
  baseline: unknown,
  current: unknown,
  threshold = 0.03,
): Regression[] {
  const changes: Regression[] = [];
  const visit = (before: unknown, after: unknown, path: string) => {
    if (typeof before === "number") {
      if (
        typeof after !== "number" ||
        !Number.isFinite(after) ||
        after > before * (1 + (/(?:Bytes|bytes|estimatedTokens)$/.test(path) ? threshold : 0))
      )
        changes.push({ path, before, after: typeof after === "number" ? after : null });
      return;
    }
    if (typeof before !== "object" || before === null) return;
    for (const [key, value] of Object.entries(before))
      visit(value, record(after)[key], path ? `${path}.${key}` : key);
  };
  visit(baseline, current, "");
  return changes;
}
