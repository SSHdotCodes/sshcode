import { collectComposerLinkTokens, collectComposerModelTokens } from "./composerContext";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";
import {
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ProviderInstanceId,
  ComposerContextId,
  EnvironmentId,
  ThreadId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  collectComposerContextReferences,
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";
import {
  assistantCitationChipLabel,
  composerContextEditorTokens,
  composerContextSendBlockReason,
  composerPromptLengthMessage,
  composerMentionPath,
  createComposerContextHistory,
  referencedComposerContext,
  reidentifyComposerContext,
  uploadedComposerContext,
  serializeComposerMessageForServer,
  pullRequestComposerContext,
  threadComposerContext,
} from "./composerContext";

const terminal = {
  version: 1 as const,
  kind: "terminal" as const,
  contextId: ComposerContextId.make("terminal-1"),
  label: "Build output",
  terminalId: "main",
  terminalLabel: "Terminal",
  lineStart: 4,
  lineEnd: 5,
  text: "build failed\nretry",
};
const image = {
  version: 1 as const,
  kind: "image" as const,
  contextId: ComposerContextId.make("image-1"),
  label: "Screenshot",
  attachmentId: "local-image",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 123,
};
const annotation = {
  version: 1 as const,
  kind: "preview-annotation" as const,
  contextId: ComposerContextId.make("preview-1"),
  label: "Button",
  annotationId: "button-1",
  pageUrl: "https://example.com",
  pageTitle: null,
  comment: "Keep the cart",
  targetSummary: "Button",
  styleChanges: [],
  screenshotContextId: image.contextId,
};

describe("mobile composer context", () => {
  it("rejects a malformed record instead of allowing the wire decoder to drop its payload", () => {
    expect(
      composerContextSendBlockReason({
        version: 1,
        records: [{ ...terminal, label: "x".repeat(201) }],
      }),
    ).not.toBeNull();
  });
  it("does not evict live recovery payloads from the editor's bounded undo history", () => {
    const records = Array.from({ length: 400 }, (_, index) => ({
      ...terminal,
      contextId: ComposerContextId.make(`terminal-${index}`),
    }));
    const text = records.map(formatComposerContextReference).join(" ");
    const restore = createComposerContextHistory();
    expect(restore(text, { version: 1, records })?.records).toEqual(records);
    expect(
      restore(records.slice(1).map(formatComposerContextReference).join(" "), {
        version: 1,
        records,
      })?.records,
    ).toEqual(records.slice(1));
  });

  it("blocks a context payload that exceeds the aggregate wire budget", () => {
    const record = {
      ...annotation,
      styleChangeDetails: Array.from({ length: 200 }, () => ({
        targetId: "element",
        selector: null,
        property: "content",
        previousValue: "x".repeat(8_000),
        value: "y".repeat(8_000),
      })),
    };
    expect(composerContextSendBlockReason({ version: 1, records: [record] })).toBeNull();
    expect(
      composerContextSendBlockReason({
        version: 1,
        records: Array.from({ length: 6 }, (_, index) => ({
          ...record,
          contextId: ComposerContextId.make(`preview-${index}`),
        })),
      }),
    ).toContain("too much context");
  });

  it("blocks over-limit recovery drafts until enough context has been removed", () => {
    const records = Array.from({ length: 201 }, (_, index) => ({
      ...terminal,
      contextId: ComposerContextId.make(`terminal-${index}`),
    }));
    expect(composerContextSendBlockReason({ version: 1, records })).toContain("at most 200");
    expect(
      composerContextSendBlockReason({ version: 1, records: records.slice(0, 200) }),
    ).toBeNull();
    expect(composerContextSendBlockReason()).toBeNull();
  });

  it("opens the full file path from bare, quoted, and canonical mentions", () => {
    expect(composerMentionPath("@src/Checkout.tsx")).toBe("src/Checkout.tsx");
    expect(composerMentionPath('@"src/My Checkout.tsx"')).toBe("src/My Checkout.tsx");
    expect(composerMentionPath("[Checkout.tsx](src/Checkout.tsx)")).toBe("src/Checkout.tsx");
    const mention = {
      version: 1 as const,
      kind: "mention" as const,
      contextId: ComposerContextId.make("mention-1"),
      label: "Checkout.tsx",
      path: "src/Checkout.tsx",
    };
    expect(
      composerMentionPath(formatComposerContextReference(mention), {
        version: 1,
        records: [mention],
      }),
    ).toBe("src/Checkout.tsx");
    expect(composerMentionPath(formatComposerContextReference(mention))).toBeNull();
    expect(composerMentionPath("$playwright")).toBeNull();
    expect(
      composerMentionPath(formatComposerContextReference(terminal), {
        version: 1,
        records: [terminal],
      }),
    ).toBeNull();
  });

  it("restores deleted payloads on undo without adding removed context to the current draft", () => {
    const restore = createComposerContextHistory();
    const source = formatComposerContextReference(annotation);
    const initial = { version: 1 as const, records: [annotation, image] };
    expect(restore("deleted", initial)).toBeUndefined();
    expect(restore(source)?.records).toEqual(initial.records);
    expect(restore("deleted")?.records ?? []).toEqual([]);
    expect(createComposerContextHistory()(source)?.records).toEqual([]);
  });
  it("keeps exact source positions and repeated references alongside existing native tokens", () => {
    const reference = formatComposerContextReference(terminal);
    const text = `Use $playwright and [app.ts](src/app.ts) with ${reference} then ${reference}`;
    const tokens = composerContextEditorTokens(text, collectComposerInlineTokens(text));
    expect(tokens.map((token) => token.type)).toEqual(["skill", "mention", "context", "context"]);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.source);
  });

  it("chips a citation as one token named by its comment, else the start of its quote", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("reply"),
      text: "  Use $playwright with @src/app.ts to check the login flow  ",
      start: 0,
      end: 58,
      prefix: "",
      suffix: "",
    };
    const link = serializeAssistantCitation(citation);
    const text = `Use $playwright on ${link} next`;
    const tokens = composerContextEditorTokens(text, collectComposerInlineTokens(text));
    expect(tokens.map((token) => [token.type, token.value])).toEqual([
      ["skill", "playwright"],
      ["citation", "Use $playwright with @src/ap…"],
    ]);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.source);
    expect(assistantCitationChipLabel({ ...citation, comment: "Why?" })).toBe("Why?");
  });

  it("counts citations as the agent reads them against the Mac's prompt limit", () => {
    const quote = "x".repeat(8_000);
    const link = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("reply"),
      text: quote,
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });
    expect(composerPromptLengthMessage(link)).toBeNull();
    // The quote block the agent receives is longer than the link the draft holds.
    const expanded = expandAssistantCitationsForProvider(link).length;
    expect(expanded).toBeGreaterThan(link.length);
    const filler = "y".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - expanded + 1);
    expect(composerPromptLengthMessage(`${link}${filler}`)).toBe(
      "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.",
    );
  });

  it("chips finished GitHub and Hugging Face links, not one still being typed or in code", () => {
    const text =
      "see https://github.com/DanielOu1208/portals and https://huggingface.co/ricursiveAI/Ripple-65B-Preview " +
      "`https://github.com/a/b` then https://github.com/c/d";
    const links = collectComposerLinkTokens(text);
    expect(links.map((link) => [link.site, link.label])).toEqual([
      ["github", "DanielOu1208/portals"],
      ["huggingface", "ricursiveAI/Ripple-65B-Preview"],
    ]);
    const tokens = composerContextEditorTokens(text, collectComposerInlineTokens(text), [], links);
    expect(tokens.filter((token) => token.type === "link")).toHaveLength(2);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.source);
  });

  it("removes deleted payloads but keeps the screenshot linked to a remaining annotation", () => {
    const context: OrchestrationMessageContext = {
      version: 1,
      records: [terminal, annotation, image],
    };
    expect(
      referencedComposerContext(formatComposerContextReference(annotation), context)?.records,
    ).toEqual([annotation, image]);
    expect(referencedComposerContext("plain text", context)).toBeUndefined();
  });

  it("reidentifies pasted records and their screenshot binding without changing repeated-reference identity", () => {
    let next = 0;
    const text = `${formatComposerContextReference(annotation)} ${formatComposerContextReference(annotation)}`;
    const imported = reidentifyComposerContext(text, [annotation, image], () => `copy-${++next}`);
    expect(collectComposerContextReferences(imported.text).map((ref) => ref.contextId)).toEqual([
      "copy-1",
      "copy-1",
    ]);
    expect(imported.context.records[0]).toMatchObject({
      contextId: "copy-1",
      screenshotContextId: "copy-2",
    });
    expect(annotation.contextId).toBe("preview-1");
  });

  it("binds uploaded files to their wire ids and preserves terminal payloads for every provider", () => {
    const context = uploadedComposerContext(
      { version: 1, records: [terminal, image] },
      [{ id: "local-image" }],
      [{ id: "uploaded-image" }],
    );
    expect(context?.records).toEqual([terminal, { ...image, attachmentId: "uploaded-image" }]);
    const prompt = projectComposerContextForProvider({
      text: formatComposerContextReference(terminal),
      records: context!.records,
    });
    expect(prompt).toContain("4 | build failed\n5 | retry");
    expect(prompt).not.toContain('unavailable="true"');
  });
});

describe("host context compatibility", () => {
  it("sends an image-only prompt as the attachment-only prompt and keeps the image", () => {
    const context: OrchestrationMessageContext = { version: 1, records: [image] };
    const reference = formatComposerContextReference(image);
    expect(serializeComposerMessageForServer(reference, context, true)).toEqual({
      text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      context,
    });
    const withProse = `${reference} what is this?`;
    expect(serializeComposerMessageForServer(withProse, context, true)).toEqual({
      text: withProse,
      context,
    });
  });

  it("carries the current PR diff file within the composer wire limits", () => {
    const metadata = {
      number: 42,
      title: "Fix checkout",
      url: "https://github.com/example/repo/pull/42",
      headBranch: "fix-checkout",
      baseBranch: "main",
      state: "open" as const,
      isDraft: false,
    };
    const record = pullRequestComposerContext(metadata, "pr-42", "src/checkout.ts");
    expect(record.filePath).toBe("src/checkout.ts");
    const prompt = projectComposerContextForProvider({
      text: formatComposerContextReference(record),
      records: [record],
    });
    expect(prompt).toContain(metadata.url);
    expect(prompt).toContain("src/checkout.ts");
    expect(composerContextSendBlockReason({ version: 1, records: [record] })).toBeNull();
    const large = pullRequestComposerContext(
      {
        ...metadata,
        title: "x".repeat(3000),
        headBranch: "y".repeat(3000),
        baseBranch: "z".repeat(3000),
      },
      "pr-42",
      `src/${"[long file]".repeat(500)}.ts`,
    );
    expect(composerContextSendBlockReason({ version: 1, records: [large] })).toBeNull();
  });

  it.each(["existing-thread", "new-task"])("serializes %s sends for an older host", (path) => {
    const pr = pullRequestComposerContext(
      {
        number: 42,
        title: "Fix checkout",
        url: "https://github.com/example/repo/pull/42",
        headBranch: "fix-checkout",
        baseBranch: "main",
        state: "open",
        isDraft: false,
      },
      "pr-42",
    );
    const review = {
      ...pr,
      contextId: ComposerContextId.make("review-1"),
      sectionId: "review",
      filePath: "checkout.ts",
      text: "Handle the empty cart",
      diff: "- old\n+ new",
    };
    const context: OrchestrationMessageContext = { version: 1, records: [terminal, review, pr] };
    const text = context.records.map(formatComposerContextReference).join(" ");
    // Missing capability on an old host is treated like false by both dispatch paths.
    const wire = serializeComposerMessageForServer(text, context, false);
    const message =
      path === "existing-thread"
        ? wire
        : buildProjectThreadStartTurnInput({
            ...wire,
            projectId: ProjectId.make("project"),
            projectCwd: "/workspace",
            threadId: "thread",
            commandId: "command",
            messageId: "message",
            createdAt: "2026-01-01T00:00:00Z",
            uploadedAttachments: [],
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceMode: "local",
            branch: null,
            worktreePath: null,
            startFromOrigin: false,
            worktreeBranchName: "unused",
          }).message;
    expect(message).not.toHaveProperty("context");
    expect(message.text).not.toContain("t3-context://");
    expect(
      upgradeLegacyContextMessage(message.text).records.find(
        (record) => record.kind === "terminal",
      ),
    ).toMatchObject({
      text: terminal.text,
      lineStart: terminal.lineStart,
      lineEnd: terminal.lineEnd,
    });
    expect(message.text).toContain(review.text);
    expect(message.text).toContain(review.diff);
    expect(message.text).toContain(pr.pullRequest!.url);
    expect(serializeComposerMessageForServer(text, context, true)).toEqual({ text, context });
    expect(context.records).toEqual([terminal, review, pr]);
  });
});

describe("threadComposerContext", () => {
  it("mints a schema-valid, stable id for agent-spawned thread ids", () => {
    const environmentId = EnvironmentId.make("env-1");
    const ref = {
      environmentId,
      threadId: ThreadId.make(`thread:mcp:${encodeURIComponent("3f2b:delegate")}:review:0`),
    };
    const contextId = threadComposerContext(ref, "Review").contextId;

    expect(() => ComposerContextId.make(contextId)).not.toThrow();
    expect(threadComposerContext(ref, "Renamed").contextId).toBe(contextId);
    expect(
      threadComposerContext({ environmentId, threadId: ThreadId.make("abc-123") }, "t").contextId,
    ).toBe("thread_abc-123");
  });
});

describe("model mention tokens", () => {
  it("chips a model reference only once it is complete and names a known model", () => {
    const known = new Set(["model:codex/gpt-6.1"]);
    const modelTokens = (text: string) =>
      composerContextEditorTokens(
        text,
        collectComposerInlineTokens(text),
        collectComposerModelTokens(text, known),
      )
        .filter((token) => token.type === "model")
        .map((token) => [token.source, token.start, token.end]);

    expect(modelTokens("Use model:codex/gpt-6.1 then stop")).toEqual([
      ["model:codex/gpt-6.1", 4, 23],
    ]);
    // Still being typed, so `gpt-6` cannot chip on the way to `gpt-6.1`.
    expect(modelTokens("Use model:codex/gpt-6.1")).toEqual([]);
    expect(modelTokens("Use model:openai/gpt-4o then stop")).toEqual([]);
    expect(modelTokens("Use `model:codex/gpt-6.1` then stop")).toEqual([]);
    expect(modelTokens(String.raw`\[\text{use model:codex/gpt-6.1 here}\] then stop`)).toEqual([]);
    const reference = formatComposerContextReference(terminal);
    const withContext = `${reference} model:codex/gpt-6.1 `;
    expect(
      composerContextEditorTokens(
        withContext,
        [],
        collectComposerModelTokens(withContext, known),
      ).map((token) => token.type),
    ).toEqual(["context", "model"]);
  });

  it("keeps a confirmed model chip when backspace removes the space after it", () => {
    const known = new Set(["model:codex/gpt-6.1"]);
    const chip = collectComposerModelTokens("Use model:codex/gpt-6.1 ", known);
    expect(chip.map((token) => token.source)).toEqual(["model:codex/gpt-6.1"]);

    const kept = collectComposerModelTokens("Use model:codex/gpt-6.1", known, chip);
    expect(kept.map((token) => [token.start, token.end])).toEqual([[4, 23]]);
    // Still kept on the next render, until the chip itself is edited.
    expect(collectComposerModelTokens("Use model:codex/gpt-6.1", known, kept)).toHaveLength(1);
    expect(collectComposerModelTokens("Use model:codex/gpt-6.1x", known, kept)).toEqual([]);
    expect(collectComposerModelTokens("model:codex/gpt-6.1", known, kept)).toEqual([]);
  });
});

describe("markdown model chips", () => {
  it("keeps missing models atomic and sends their exact markdown beside file mentions", () => {
    const source = "[Muse Ember](t3-model://v1/gone/qwen%28openai%29)";
    const text = `test ${source} and [muse](muse) `;
    const models = collectComposerModelTokens(text, new Set());
    expect(models).toMatchObject([
      { instanceId: "gone", model: "qwen(openai)", label: "Muse Ember", source },
    ]);
    const tokens = composerContextEditorTokens(text, collectComposerInlineTokens(text), models);
    expect(tokens.map((token) => token.type)).toEqual(["model", "mention"]);
    expect(serializeComposerMessageForServer(text, undefined, true)).toEqual({ text });
    expect(serializeComposerMessageForServer(text, undefined, false)).toEqual({
      text: text.trim(),
    });
  });
});
