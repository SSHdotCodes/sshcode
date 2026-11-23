import {
  buildEnrichedModelReferences,
  enrichedModelReference,
  enrichedModelDetails,
  enrichedModelLinkRegex,
  enrichedTextLinkRegex,
} from "./enrichedLinkPresentation";
import { describe, expect, it } from "vite-plus/test";
import type { ComposerContextId, ReviewCommentContextRecord } from "@t3tools/contracts";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillLinkRegex,
  enrichedSkillReference,
  ENRICHED_INLINE_FILE_LINK_REGEX,
} from "./enrichedLinkPresentation";

describe("Enriched link presentation", () => {
  it("recognizes file-shaped code without turning commands or URLs into links", () => {
    for (const path of [
      "src/app.tsx",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\app.tsx",
      "app.tsx:12:3",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(path), path).toBe(true);
    }
    for (const text of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(text), text).toBe(false);
    }
  });

  it("only recognizes complete known skill names and escapes their punctuation", () => {
    const regex = enrichedSkillLinkRegex([{ name: "check" }, { name: "check.mobile" }]);
    expect(regex?.exec("Try $check.mobile next")?.[0]).toBe("$check.mobile");
    expect(regex?.exec("Try $check-mobile next")).toBeNull();
    expect(regex?.exec("Try $checkXmobile next")).toBeNull();
    expect(regex?.exec("prefix$check next")).toBeNull();
    expect(enrichedSkillLinkRegex([])).toBeNull();
  });
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "recognizes and presents known skills with %s while rejecting adjacent tokens",
    (sigil) => {
      const skills = [{ name: "check", displayName: "Check" }];
      const regex = enrichedSkillLinkRegex(skills)!;
      expect(regex.exec(`Try ${sigil}check now`)?.[0]).toBe(`${sigil}check`);
      expect(enrichedSkillReference(`${sigil}check`, skills)).toBe(skills[0]);
      expect(regex.test(`prefix${sigil}check`)).toBe(false);
      expect(regex.test(`${sigil}check-extra`)).toBe(false);
      expect(regex.test(`${sigil}unknown`)).toBe(false);
      expect(regex.test(`${sigil}${sigil}check`)).toBe(false);
    },
  );
  it("matches only the complete URL, including literal regex metacharacters", () => {
    const url = "file:///workspace/app[1].tsx?line=3+4";
    const pattern = new RegExp(enrichedLinkVariantPattern(url));
    expect(pattern.test(url)).toBe(true);
    expect(pattern.test(`${url}/child`)).toBe(false);
    expect(pattern.test("file:///workspace/app1Xtsx?line=34")).toBe(false);
  });

  it("uses context identity for PR status even when labels are identical", () => {
    const record: ReviewCommentContextRecord = {
      version: 1,
      contextId: "review_1" as ComposerContextId,
      kind: "review-comment",
      label: "Review",
      sectionId: "pull-request:7",
      sectionTitle: "Review",
      filePath: "app.tsx",
      startIndex: 0,
      endIndex: 1,
      rangeLabel: "line 1",
      text: "Comment",
      diff: "",
      pullRequest: {
        number: 7,
        title: "Review",
        url: "https://github.com/example/repo/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: "merged",
        isDraft: false,
      },
    };
    expect(
      enrichedContextLinkPresentation("t3-context://v1/review-comment/review_1", [record]),
    ).toEqual({ color: "#8a70dd", icon: "git" });
    expect(
      enrichedContextLinkPresentation("t3-context://v1/review-comment/review_2", [record]),
    ).toEqual({ color: "#8a70dd", icon: "markdown" });
  });

  it("retains recognizable presentation for unavailable and future context kinds", () => {
    expect(enrichedContextLinkPresentation("t3-context://v1/terminal/missing")).toEqual({
      color: "#009f6e",
      icon: "bash",
    });
    expect(enrichedContextLinkPresentation("t3-context://v1/skill/missing")).toEqual({
      color: "#b261be",
      icon: "mcp",
    });
    expect(enrichedContextLinkPresentation("t3-context://v1/future/missing")).toEqual({
      color: "#0090cd",
      icon: "default",
    });
    expect(enrichedContextLinkPresentation("https://example.com/terminal/missing")).toBeUndefined();
  });
});

describe("model mentions", () => {
  it("recognizes only complete known models in prose and resolves their display names", () => {
    const models = buildEnrichedModelReferences([
      {
        instanceId: "codex",
        driver: "codex",
        models: [
          { slug: "gpt-6.1", name: "OpenAI GPT-6.1", subProvider: "OpenAI" },
          { slug: "gpt-6.1-sol[1m]", name: "GPT-6.1 Sol" },
        ],
      },
    ]);
    const regex = enrichedModelLinkRegex(models);
    for (const text of [
      "Try model:codex/gpt-6.1 next",
      "Try (model:codex/gpt-6.1).",
      "Try [model:codex/gpt-6.1] next",
      '"model:codex/gpt-6.1"',
    ]) {
      const source = regex?.exec(text)?.[0];
      expect(source, text).toBe("model:codex/gpt-6.1");
      expect(enrichedModelReference(source!, models)?.label).toBe("GPT-6.1");
    }
    expect(regex?.exec("Try model:codex/gpt-6.1-sol[1m].")?.[0]).toBe(
      "model:codex/gpt-6.1-sol[1m]",
    );
    for (const text of [
      "model:openai/gpt-4o",
      "model:codex/gpt-6.1-extra",
      "model:codex/gpt-6.1.2",
      "model:codex/gpt-6X1",
      "premodel:codex/gpt-6.1",
    ]) {
      expect(regex?.exec(text), text).toBeNull();
    }
    expect(enrichedModelReference("model:openai/gpt-4o", models)).toBeUndefined();
    expect(enrichedModelLinkRegex([])).toBeNull();
    expect(enrichedTextLinkRegex([], [])).toBeNull();
    const combined = enrichedTextLinkRegex([{ name: "review" }], models);
    expect(
      "Use $review with (model:codex/gpt-6.1).".match(new RegExp(combined!.source, "gu")),
    ).toEqual(["$review", "model:codex/gpt-6.1"]);
  });
});

describe("model mentions", () => {
  it("describes a mentioned model the way its web popover does", () => {
    const [direct, routed] = buildEnrichedModelReferences([
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        models: [{ slug: "gpt-6.1", name: "GPT-6.1" }],
      },
      {
        instanceId: "opencode",
        driver: "opencode",
        models: [{ slug: "traex/gpt-6.1", name: "GPT-6.1", subProvider: "Traex" }],
      },
    ]);
    expect(enrichedModelDetails(direct!)).toBe("Codex\nmodel:codex/gpt-6.1");
    expect(enrichedModelDetails(routed!)).toBe("Traex\nmodel:opencode/traex/gpt-6.1");
  });
});

it("renders the debug context as a compact neutral pill using its label, with no workflow payload", () => {
  const presentation = enrichedContextLinkPresentation("t3-context://v1/debug/debug_workflow");
  expect(presentation?.color).toBe("#7f8793");
  expect(presentation?.icon).toBeDefined();
});

it("draws model links with provider artwork and retains missing model names", () => {
  const known = "[Muse Ember](t3-model://v1/muse/qwen%28openai%29)";
  const missing = "[Retired Ember](t3-model://v1/gone/ember)";
  const models = buildEnrichedModelReferences(
    [
      {
        instanceId: "muse",
        driver: "muse",
        displayName: "Muse Account",
        models: [{ slug: "qwen(openai)", name: "Muse Ember" }],
      },
    ],
    new Set([known, missing]),
  );
  expect(enrichedModelReference("t3-model://v1/muse/qwen%28openai%29", models)).toMatchObject({
    label: "Muse Ember",
    driver: "muse",
  });
  expect(enrichedModelReference("t3-model://v1/gone/ember", models)).toMatchObject({
    label: "Retired Ember",
    driver: "",
  });
});
