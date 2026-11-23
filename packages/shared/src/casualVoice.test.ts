import { describe, expect, it } from "vite-plus/test";
import {
  cloudCasualVoicePrompt,
  segmentCasualMessage,
  parseCasualDecisions,
  parseCasualVerdict,
  casualVisibleText,
  casualHiddenLabel,
  foldCasualStatuses,
  planCasualReveal,
  casualMessageRole,
  casualVoiceInstructions,
  casualVoiceCloudOptions,
  casualVoiceActive,
} from "./casualVoice.ts";

const lower = (text: string) =>
  text
    .split(/(⟦[CBPUN]\d+⟧)/)
    .map((part) => (/^⟦[CBPUN]\d+⟧$/.test(part) ? part : part.toLowerCase()))
    .join("");
const echo = (original: string, role: "final" | "update" = "final") => {
  const source = segmentCasualMessage(original, role);
  return {
    source,
    lines: source.input.segments
      .map((segment) => `${segment.id} say: ${lower(segment.text)}`)
      .join("\n"),
  };
};
describe("v2 segments and placeholders", () => {
  it.each([
    "Check `ServerSettings` in /Users/Alex/Test.ts at https://Example.test/A and version v2-beta, 42, 1.2.3.",
    "First sentence. Second sentence?\n\n# Heading\n- List item\n1. Another item",
    "Before.\n```TS\nconst Important = 42;\n```\nAfter.",
    "Before.\n~~~py\nprint('Hello')\n~~~\nAfter.",
    "Before.\n    KeepExact = 4\n    MoreCode = 5\nAfter.",
    "Literal ⟦P1⟧ and `⟦B1⟧` stay exact.\n```txt\n⟦N1⟧\n```",
    "Run npm test -- --Exact=42",
    'Open "/Users/Alex/Application Support/App" exactly.',
  ])("round trips protected content and markdown: %s", (original) => {
    const { source, lines } = echo(original);
    const result = parseCasualDecisions(source, lines);
    expect(result).not.toBeNull();
    for (const value of source.placeholders.values())
      expect(casualVisibleText(result!)).toContain(value);
    expect(
      source.segments.map((segment) => segment.before + segment.original).join("") +
        source.trailing,
    ).toBe(original);
  });
  it("keeps blocks, whole lists and headings as their own segments", () => {
    const source = segmentCasualMessage(
      "# Heading. Next.\n- One. Two.\n```ts\nlet X = 1;\n```",
      "final",
    );
    expect(source.input.segments.map((part) => part.text)).toEqual([
      "# Heading. Next.",
      "⟦B2⟧",
      "⟦B1⟧",
    ]);
  });
  it("lowercases names, acronyms and products in prose, without treating them as code", () => {
    const { source } = echo("Alex uses GitHub, API and SSHCode.");
    expect(source.placeholders.size).toBe(0);
    expect(
      parseCasualDecisions(source, "1 say: alex uses github, api and sshcode."),
    ).not.toBeNull();
  });
});
describe("ordered decisions and bursts", () => {
  it("parses say continuations and preserves placeholders once across the burst", () => {
    const source = segmentCasualMessage("The tests in `Thing` return 42.", "final");
    const result = parseCasualDecisions(
      source,
      "1 say: ok found it\n+ say: the tests in ⟦C1⟧ return ⟦N1⟧.",
    );
    expect(result?.blocks[0]?.bubbles).toEqual(["ok found it", "the tests in `Thing` return 42."]);
    expect(casualVisibleText(result!)).toContain("ok found it\n\nthe tests");
  });
  it.each([
    "+ say: orphan",
    "1 say: ⟦C1⟧ ⟦N1⟧\n+ say: 🙂",
    "1 say: ⟦C1⟧ ⟦N1⟧\n+ say: GitHub",
    "1 status: checking it\n+ say: orphan",
    "1 hide: filler\n+ say: orphan",
    "1 say: ⟦C1⟧\n+ say: ⟦C1⟧ ⟦N1⟧",
    "1 say: done\n+ say: ⟦N1⟧",
    "1 say: ⟦N1⟧ ⟦C1⟧",
    "1 say: ⟦C2⟧ ⟦N1⟧",
    "2 say: wrong order",
    "1-2 say: too many",
    "1 say: ⟦C1⟧ ⟦N1⟧\n1 say: duplicate",
    "1 say:",
    "```\n1 say: hello\n```",
  ])("rejects malformed, missing, repeated or reordered coverage/placeholders: %s", (output) => {
    expect(
      parseCasualDecisions(segmentCasualMessage("Use `Exact` at 42.", "final"), output),
    ).toBeNull();
  });
  it("accepts contiguous ranges, but never combines blocks/list items/headings", () => {
    expect(
      parseCasualDecisions(
        segmentCasualMessage("I checked it. It works.", "final"),
        "1-2 say: i checked it and it works.",
      ),
    ).not.toBeNull();
    expect(
      parseCasualDecisions(
        segmentCasualMessage("- First\n- Second", "final"),
        "1-2 say: - first - second",
      ),
    ).toBeNull();
    const block = segmentCasualMessage("```ts\nconst X = 1\n```", "final");
    for (const output of [
      "1 hide: filler",
      "1 status: ⟦B1⟧",
      "1 say: code ⟦B1⟧",
      "1 say: ⟦B1⟧\n+ say: more",
    ])
      expect(parseCasualDecisions(block, output)).toBeNull();
  });
});
describe("safe hide and status decisions", () => {
  it("shows expandable hidden originals with a line count", () => {
    const source = segmentCasualMessage("The fix is ready.\nHope this helps.", "final");
    const display = parseCasualDecisions(source, "1 say: the fix is ready.\n2 hide: pleasantry");
    expect(display?.blocks[1]).toMatchObject({ kind: "hide", original: "Hope this helps." });
    expect(casualHiddenLabel(display!.blocks[1]!.original)).toBe("hid 1 line");
    expect(casualHiddenLabel("a\nb")).toBe("hid 2 lines");
    expect(casualVisibleText(display!)).not.toContain("Hope");
  });
  it.each([
    "A unique detail.",
    "Do you want this?",
    "I decided to keep it.",
    "The tests passed.",
    "An error occurred.",
    "Warning, this has a risk.",
    "There are 42 items.",
    "Use `Exact`.",
    "Open /A/B.",
  ])("never hides useful or protected content: %s", (original) =>
    expect(
      parseCasualDecisions(segmentCasualMessage(original, "update"), "1 hide: filler"),
    ).toBeNull(),
  );
  it("only folds pure update narration and caps status at eight words", () => {
    const source = segmentCasualMessage("Let me read /A/B.", "update");
    const output = "1 status: reading ⟦P1⟧";
    expect(parseCasualDecisions(source, output)?.blocks[0]?.text).toBe("reading /A/B.");
    expect(
      parseCasualDecisions(source, "1 status: i am now going to start reading all of ⟦P1⟧"),
    ).toBeNull();
    expect(
      parseCasualDecisions(
        segmentCasualMessage("Tests failed.", "update"),
        "1 status: checking tests",
      ),
    ).toBeNull();
    expect(
      parseCasualDecisions(segmentCasualMessage("Let me read /A/B.", "final"), output),
    ).toBeNull();
    expect(foldCasualStatuses(["reading file", "checking tests", "reading file"])).toBe(
      "reading file · checking tests",
    );
  });
  it("keeps questions and uncertainty instead of dropping them", () => {
    expect(
      parseCasualDecisions(segmentCasualMessage("It probably works.", "final"), "1 say: it works."),
    ).toBeNull();
    expect(
      parseCasualDecisions(
        segmentCasualMessage("It is not ready.", "final"),
        "1 say: it is ready.",
      ),
    ).toBeNull();
    expect(
      parseCasualDecisions(
        segmentCasualMessage("Do you want it?", "final"),
        "1 say: do you want it.",
      ),
    ).toBeNull();
  });
});
describe("strict voice checks", () => {
  it.each([
    "GitHub works",
    "api Works",
    "Éxact",
    "ǅ titlecase",
    "hello—there",
    "hello–there",
    "hello 🙂",
    "nice ❤",
    "ok 🇺🇸",
    "ok 👨‍💻",
    "yes 👍🏽",
    "yes 1️⃣",
    "sure :)",
    "sure ;-)",
    "ok :P",
    "ok <3",
    "ok ^_^",
    "ok uwu",
  ])("rejects capitals, dashes, emoji and emoticons: %s", (text) =>
    expect(
      parseCasualDecisions(segmentCasualMessage("Hello there.", "final"), `1 say: ${text}`),
    ).toBeNull(),
  );
  it("allows capitals only in exact placeholders, and never invents raw numbers", () => {
    expect(
      parseCasualDecisions(segmentCasualMessage("Use `ExactID`.", "final"), "1 say: use ⟦C1⟧."),
    ).not.toBeNull();
    expect(
      parseCasualDecisions(segmentCasualMessage("Hello.", "final"), "1 say: hello 3"),
    ).toBeNull();
    expect(
      parseCasualDecisions(segmentCasualMessage("Use `🙂`.", "final"), "1 say: use ⟦C1⟧."),
    ).toBeNull();
    expect(casualVoiceInstructions([])).toContain("No emojis or emoticons, ever");
    expect(casualVoiceInstructions([])).toContain("names, acronyms and products");
  });
});
describe("live display timing and role", () => {
  it("scales the delays with length and caps a complete burst at six seconds", () => {
    const plan = planCasualReveal([10, 10, 50, 200], {
      live: true,
      visible: true,
      reducedMotion: false,
    });
    expect(plan[0]).toBe(0);
    const gaps = plan.slice(1).map((at, index) => at - plan[index]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(800);
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    expect(gaps[2]).toBeLessThanOrEqual(2500);
    expect(plan.at(-1)).toBeLessThanOrEqual(6000);
    expect(
      planCasualReveal(Array(20).fill(300), { live: true, visible: true, reducedMotion: false }).at(
        -1,
      ),
    ).toBe(6000);
  });
  it.each([
    { live: false, visible: true, reducedMotion: false },
    { live: true, visible: false, reducedMotion: false },
    { live: true, visible: true, reducedMotion: true },
  ])("shows all history/hidden/reduced-motion bubbles immediately: %j", (options) =>
    expect(planCasualReveal([10, 100, 200], options)).toEqual([0, 0, 0]),
  );
  it("classifies intermediate messages as updates and only a settled run's last reply as final", () => {
    const messages = [
      { id: "one", runId: "run", role: "assistant" },
      { id: "two", runId: "run", role: "assistant" },
    ];
    expect(casualMessageRole(messages[0]!, messages, [{ id: "run", status: "completed" }])).toBe(
      "update",
    );
    expect(casualMessageRole(messages[1]!, messages, [{ id: "run", status: "completed" }])).toBe(
      "final",
    );
    expect(casualMessageRole(messages[1]!, messages, [{ id: "run", status: "running" }])).toBe(
      "update",
    );
  });
});

describe("reasoning steer contract", () => {
  it("leaves old input bytes unchanged and masks bounded steer context separately", () => {
    const original = "I found `active` at 42.";
    const old = segmentCasualMessage(original, "update");
    expect(JSON.stringify(old.input)).toBe(
      '{"role":"update","segments":[{"id":1,"text":"I found ⟦C1⟧ at ⟦N1⟧."}]}',
    );
    const source = segmentCasualMessage(original, "update", {
      source: "reasoning",
      replyTo:
        "check `other` at /tmp/example.json and https://example.invalid, 99. " + "x".repeat(800),
    });
    expect(source.input.source).toBe("reasoning");
    expect(source.input.replyTo).not.toContain("`other`");
    expect(source.input.replyTo).not.toContain("/tmp/example.json");
    expect(source.input.replyTo).not.toContain("https://example.invalid");
    expect(source.input.replyTo).not.toContain("99");
    expect(source.input.replyTo!.match(/x/g)!.length).toBeLessThan(600);
    expect(source.input.segments).toEqual(old.input.segments);
    expect(cloudCasualVoicePrompt(source.input, [])).toContain(JSON.stringify(source.input));
    expect(casualVoiceInstructions([], "reasoning")).toContain("never rewrite, quote or echo it");
    expect(casualVoiceInstructions([])).not.toContain("Reasoning inputs");
  });
  it("allows hiding detailed thoughts and code while retaining say guards", () => {
    const original = "I must check `active` at 42. It probably cannot fail.";
    const message = segmentCasualMessage(original, "update");
    const source = segmentCasualMessage(original, "update", {
      source: "reasoning",
      replyTo: "is it ready?",
    });
    expect(parseCasualDecisions(message, "1-2 hide: filler")).toBeNull();
    expect(parseCasualDecisions(source, "1-2 hide: filler")?.blocks[0]?.kind).toBe("hide");
    expect(parseCasualDecisions(source, "1 say: it is ready\n2 hide: filler")).toBeNull();
    expect(parseCasualDecisions(source, "1 hide: filler\n2 say: it can fail.")).toBeNull();
    expect(
      parseCasualDecisions(source, "1 hide: filler\n2 say: it probably cannot fail."),
    ).not.toBeNull();
    const code = segmentCasualMessage("```ts\nrun()\n```", "update", {
      source: "reasoning",
      replyTo: "continue",
    });
    expect(parseCasualDecisions(code, "1 hide: filler")).not.toBeNull();
    // Steer-only placeholders cannot leak into a reply.
    const context = segmentCasualMessage("Ready.", "update", {
      source: "reasoning",
      replyTo: "check 52",
    });
    expect(parseCasualDecisions(context, "1 say: ready ⟦N1⟧")).toBeNull();
  });
});

describe("lossless tables and lists", () => {
  const table = "| Name | Result |\n| :--- | ---: |\n| Case A | 42 |\n| Case B | 73 |";
  const list = "- Keep `Exact`\n  with this continuation\n  and another line\n- Keep /tmp/Thing.ts";
  it.each([
    table,
    list,
    "1. First Item\n   continued exactly\n2. Second Item",
    "1) First Item\n2) Second Item",
    table.replace(/\n/g, "\r\n"),
  ])("preserves a protected layout byte-for-byte: %s", (original) => {
    const source = segmentCasualMessage(original, "final");
    expect(source.input.segments).toEqual([{ id: 1, text: "⟦B1⟧" }]);
    const display = parseCasualDecisions(source, "1 say: ⟦B1⟧");
    expect(casualVisibleText(display!)).toBe(original);
    expect(parseCasualDecisions(source, "1 say: flattened layout")).toBeNull();
  });
  it("rewrites mixed prose around a table and a list while preserving their bytes and spacing", () => {
    const original = `Here Are The Results.\n\n${table}\n\nNext Steps.\n${list}\nDone.`;
    const source = segmentCasualMessage(original, "final");
    expect(source.input.segments.map((segment) => segment.text)).toEqual([
      "Here Are The Results.",
      "⟦B1⟧",
      "Next Steps.",
      "⟦B2⟧",
      "Done.",
    ]);
    const display = parseCasualDecisions(
      source,
      "1 say: here are the results.\n2 say: ⟦B1⟧\n3 say: next steps.\n4 say: ⟦B2⟧\n5 say: done.",
    );
    expect(casualVisibleText(display!)).toBe(
      `here are the results.\n\n${table}\n\nnext steps.\n${list}\ndone.`,
    );
  });
  it("does not mask lists or tables inside a code block a second time", () => {
    const original = `\`\`\`md\n${list}\n${table}\n\`\`\``;
    const source = segmentCasualMessage(original, "final");
    expect(source.placeholders.size).toBe(1);
    expect(source.input.segments).toEqual([{ id: 1, text: "⟦B1⟧" }]);
    expect(casualVisibleText(parseCasualDecisions(source, "1 say: ⟦B1⟧")!)).toBe(original);
  });
});

it.each([undefined, "reasoning"] as const)(
  "preserves say/status placeholders and only lets reasoning hides drop them (%s)",
  (kind) => {
    const source = segmentCasualMessage(
      "Let me check `Exact` at /tmp/Thing.ts and 42.",
      "update",
      kind ? { source: kind, replyTo: "check again" } : undefined,
    );
    expect(Boolean(parseCasualDecisions(source, "1 hide: filler"))).toBe(kind === "reasoning");
    expect(parseCasualDecisions(source, "1 say: checking it")).toBeNull();
    expect(parseCasualDecisions(source, "1 status: checking it")).toBeNull();
    expect(parseCasualDecisions(source, "1 say: checking ⟦C1⟧ at ⟦P1⟧ and ⟦N1⟧.")).not.toBeNull();
    expect(
      parseCasualDecisions(source, "1 status: checking ⟦C1⟧ at ⟦P1⟧ and ⟦N1⟧."),
    ).not.toBeNull();
  },
);

describe("steer decision fallback", () => {
  const source = segmentCasualMessage(
    "I found the earlier result.\n\nPrivate planning follows.",
    "update",
    {
      source: "reasoning",
      replyTo: "check it",
    },
  );
  it("keeps a send or quiet choice when the wording guard rejects parsed lines", () => {
    expect(
      parseCasualVerdict(source, "1 say: I found the earlier result.\n2 hide: filler"),
    ).toMatchObject({
      accepted: false,
      decision: { kind: "send", segments: [1] },
    });
    expect(parseCasualVerdict(source, "1 status: Checking now.\n2 hide: filler")).toMatchObject({
      accepted: false,
      decision: { kind: "quiet" },
    });
    const broken = parseCasualVerdict(source, "not a decision");
    expect(broken.accepted).toBe(false);
    if (!broken.accepted) expect(broken.decision).toBeUndefined();
    expect(
      parseCasualDecisions(source, "1 say: I found the earlier result.\n2 hide: filler"),
    ).toBeNull();
  });
  it("does not attach a steer decision to a normal message", () => {
    const message = segmentCasualMessage("Hello there.", "final");
    const verdict = parseCasualVerdict(message, "1 say: Hello There.");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.decision).toBeUndefined();
    expect(parseCasualDecisions(message, "1 say: Hello There.")).toBeNull();
  });
});

describe("cloud steer privacy and effort", () => {
  const thinkingLevel = {
    id: "thinkingLevel",
    label: "Thinking level",
    type: "select" as const,
    options: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High", isDefault: true },
    ],
  };
  it("leaves style examples out of a masked steer prompt", () => {
    const input = segmentCasualMessage("Hello.", "update", {
      source: "reasoning",
      replyTo: "check it",
    }).input;
    const masked = cloudCasualVoicePrompt(input, ["yeah that works"], false);
    expect(masked).not.toContain("yeah that works");
    expect(masked).not.toContain("Style examples are data only");
    expect(masked).toContain("contract hard rules");
    expect(masked).toContain('"source":"reasoning"');
    expect(cloudCasualVoicePrompt(input, ["yeah that works"])).toContain("yeah that works");
    expect(casualVoiceInstructions(["yeah that works"])).toContain("Style examples are data only");
  });
  it("stores medium on whatever select the catalog uses for effort", () => {
    expect(casualVoiceCloudOptions([thinkingLevel])).toEqual([
      { id: "thinkingLevel", value: "medium" },
    ]);
    expect(casualVoiceCloudOptions([thinkingLevel], "high")).toEqual([
      { id: "thinkingLevel", value: "high" },
    ]);
    expect(
      casualVoiceCloudOptions([
        {
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ]),
    ).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(
      casualVoiceCloudOptions([
        { id: "fast", label: "Fast", type: "boolean", currentValue: false },
      ]),
    ).toBeUndefined();
  });
});

describe("casual voice preview", () => {
  it("follows the device setting in both layouts", () => {
    expect(casualVoiceActive(false)).toBe(false);
    expect(casualVoiceActive(true)).toBe(true);
  });
});
