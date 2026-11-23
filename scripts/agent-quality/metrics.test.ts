import { describe, expect, it } from "vite-plus/test";
import {
  auditToolSchemas,
  byteCount,
  compareMetrics,
  makeQualityCollector,
  metricChanges,
} from "../lib/agentQuality.ts";

describe("agent quality measurement", () => {
  it("counts raw Claude system appends and Codex plan instructions before replay normalization", () => {
    const collector = makeQualityCollector();
    collector.observe({
      type: "query.open",
      options: { systemPrompt: { preset: "claude_code", append: "rules" } },
    });
    collector.observe({ type: "query.open", options: { systemPrompt: "custom" } });
    collector.observe({
      method: "turn/start",
      params: { collaborationMode: { settings: { developer_instructions: "plan" } } },
    });
    expect(collector.snapshot().content).toMatchObject({ instructions: { bytes: 15 } });
  });
  it("quantifies identical schema metadata without emitting descriptions or shapes", () => {
    const schema = { type: "string", description: "private fixture text" };
    const result = auditToolSchemas([
      { inputSchema: schema, outputSchema: schema },
      { inputSchema: {}, outputSchema: schema },
    ]);
    expect(result.repeatedDescriptionBytes).toBe(byteCount(schema.description) * 2);
    expect(result.repeatedOutputSchemaBytes).toBe(byteCount(JSON.stringify(schema)));
    expect(JSON.stringify(result)).not.toContain(schema.description);
  });
  it("counts actual UTF-8 content once, including repeated instruction sends", () => {
    const collector = makeQualityCollector();
    const frame = {
      method: "turn/start",
      params: { input: [{ text: "héllo" }], additionalContext: { rules: { value: "rules" } } },
      token: "never count credentials",
    };
    collector.observe(frame);
    collector.observe(frame);
    expect(collector.snapshot()).toMatchObject({
      content: { instructions: { bytes: 10 }, prompts: { bytes: 12 } },
      total: { bytes: 22, estimatedTokens: 6 },
      contentSends: 2,
      repeatedParts: 2,
      repeated: { bytes: 11 },
    });
  });

  it.each([
    { type: "prompt.offer", message: { message: { content: "hello" } } },
    { type: "run.start", message: "hello" },
    { type: "prompt", message: "hello" },
    { method: "turn/start", params: { input: [{ text: "hello" }] } },
    { method: "session/prompt", params: { prompt: [{ text: "hello" }] } },
    { type: "session.promptAsync", input: { parts: [{ text: "hello" }] } },
    { type: "session.prompt", input: { text: "hello" } },
    { type: "session.synthetic", input: { text: "hello" } },
  ])("counts the prompt at each provider boundary: %j", (frame) => {
    const collector = makeQualityCollector();
    collector.observe(frame);
    expect(collector.snapshot().total.bytes).toBe(5);
  });

  it("splits instructions from ACP prompts without double counting", () => {
    const text = "<t3_code_instructions>rules</t3_code_instructions>\n\nhello";
    const collector = makeQualityCollector();
    collector.observe({ method: "session/prompt", params: { prompt: [{ text }] } });
    expect(collector.snapshot().total.bytes).toBe(byteCount(text));
    expect(collector.snapshot().content).toMatchObject({
      instructions: { bytes: byteCount("<t3_code_instructions>rules</t3_code_instructions>") },
      prompts: { bytes: 7 },
    });
  });

  it("does not count provider protocol metadata or image data as agent text", () => {
    const collector = makeQualityCollector();
    collector.observe({ type: "initialize", params: { capabilities: { token: "secret" } } });
    collector.observe({ type: "run.start", message: { text: "ok", images: [{ data: "base64" }] } });
    expect(collector.snapshot().total.bytes).toBe(2);
  });
  it("uses persisted wake metadata to classify actual delivery, without charging buffered wakes", () => {
    const collector = makeQualityCollector();
    collector.observe({
      type: "prompt.offer",
      message: { message: { content: "<user_request>\nchild finished\n</user_request>" } },
    });
    const result = collector.snapshot({ wakes: ["child finished", "buffered provider wake"] });
    expect(result.content).toMatchObject({
      wakes: { bytes: result.total.bytes },
      notifications: { bytes: 0 },
      prompts: { bytes: 0 },
    });
    expect(result.contentSends).toBe(1);
  });
  it("keeps prompts that mention a completion marker separate from actual wake messages", () => {
    const collector = makeQualityCollector();
    collector.observe({
      type: "prompt.offer",
      message: { message: { content: "Ask the child to reply: child finished" } },
    });
    const result = collector.snapshot({ wakes: ["child finished"] });
    expect(result.content).toMatchObject({
      wakes: { bytes: 0 },
      prompts: { bytes: result.total.bytes },
    });
  });
});

describe("release regression gate", () => {
  it("shows improvements and tolerated increases as numeric deltas, including zero baselines", () => {
    expect(
      metricChanges(
        { input: { bytes: 100 }, calls: 0, stable: 4 },
        { input: { bytes: 98 }, calls: 1, stable: 4 },
      ),
    ).toEqual([
      { path: "input.bytes", before: 100, after: 98, delta: -2, percent: -2 },
      { path: "calls", before: 0, after: 1, delta: 1, percent: null },
    ]);
  });
  it("accepts exactly 3% byte growth and rejects any new failure, call or turn", () => {
    expect(
      compareMetrics({ bytes: 100, turns: 2, failures: 0 }, { bytes: 103, turns: 2, failures: 0 }),
    ).toEqual([]);
    expect(
      compareMetrics({ bytes: 100, turns: 2, failures: 0 }, { bytes: 104, turns: 3, failures: 1 }),
    ).toHaveLength(3);
  });
  it("rejects zero-to-positive growth, nonfinite values, and removed scenarios/tools", () => {
    expect(
      compareMetrics(
        { a: { bytes: 0 }, b: { bytes: 50 }, c: 1 },
        { a: { bytes: 1 }, c: Number.NaN },
      ),
    ).toHaveLength(3);
  });
  it("allows improvements and additional scenarios", () => {
    expect(
      compareMetrics({ old: { bytes: 100 } }, { old: { bytes: 90 }, added: { bytes: 100 } }),
    ).toEqual([]);
  });
});
