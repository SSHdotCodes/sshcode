/**
 * The T3 MCP credential each thread's provider session should expose to its
 * agent. The session manager writes it before a session starts; adapters read
 * it when they build provider launch options.
 *
 * @module provider-core/server/McpProviderSessions
 */
// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
// Results are taken as soon as the harness reports the call done. Harnesses that report
// their own outputs (Claude, Codex) never take them, so keep few per chat.
const MAX_KEPT_TOOL_RESULTS = 32;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly path: string | undefined;
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

interface KeptToolResult {
  readonly toolName: string;
  readonly inputHash: string;
  readonly output: unknown;
}

const hashText = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");

export const hashToolInput = (input: unknown) => hashText(stableStringify(input));

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: {
        readonly html: string;
        readonly path?: string | undefined;
        readonly title: string;
        readonly height: number;
      },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise only unique input matches count.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: {
        readonly html?: unknown;
        readonly path?: unknown;
        readonly title?: unknown;
        readonly height?: unknown;
      },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
    /**
     * Records a bounded T3 MCP tool result so ACP adapters whose harness omits
     * MCP tool outputs on `tool_call_update` (such as `agy acp`) can still hydrate
     * delegation IDs, MCP error flags, and expanded tool outputs.
     */
    readonly recordToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      output: unknown,
    ) => Effect.Effect<void>;
    readonly takeToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      options?: { readonly exact?: boolean },
    ) => Effect.Effect<unknown | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const matchingPageIndex = (
  kept: ReadonlyArray<KeptHtmlRender>,
  input: {
    readonly html?: unknown;
    readonly path?: unknown;
    readonly title?: unknown;
    readonly height?: unknown;
  },
): number => {
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const sameFrame = (page: KeptHtmlRender) => page.title === input.title && page.height === height;
  if (input.path != null && input.html != null) return -1;
  // Match successive snapshots of an edited file in publication order.
  if (typeof input.path === "string" && input.path.length > 0) {
    return kept.findIndex((page) => page.path === input.path && sameFrame(page));
  }
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) return -1;
  const htmlHash = hashText(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.path === undefined &&
    sameFrame(page) &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResults = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptToolResult>>());
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
        yield* Ref.update(toolResults, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
      }
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(toolResults, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
      ),
    recordHtmlRender: (threadId, input, reference) =>
      Ref.update(htmlRenders, (current) =>
        new Map(current).set(
          threadId,
          [
            ...(current.get(threadId) ?? []),
            {
              path: input.path,
              title: input.title,
              height: input.height,
              htmlLength: input.html.length,
              htmlHash: hashText(input.html),
              // Copy the tail so its backing storage cannot retain the entire HTML string.
              htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                "utf16le",
              ),
              reference,
            },
          ].slice(-MAX_KEPT_HTML_RENDERS),
        ),
      ),
    takeHtmlRender: (threadId, input, reported) =>
      Ref.modify(htmlRenders, (current) => {
        const kept = current.get(threadId) ?? [];
        const index =
          reported === undefined
            ? matchingPageIndex(kept, input)
            : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
        if (index === -1) {
          return [undefined, current];
        }
        const rest = kept.filter((_, keptIndex) => keptIndex !== index);
        const next = new Map(current);
        if (rest.length === 0) {
          next.delete(threadId);
        } else {
          next.set(threadId, rest);
        }
        return [kept[index]!.reference, next];
      }),
    recordToolResult: (threadId, toolName, input, output) =>
      Ref.update(toolResults, (current) =>
        new Map(current).set(
          threadId,
          [
            ...(current.get(threadId) ?? []),
            { toolName, inputHash: hashToolInput(input), output },
          ].slice(-MAX_KEPT_TOOL_RESULTS),
        ),
      ),
    takeToolResult: (threadId, toolName, input, options) =>
      Ref.modify(toolResults, (current) => {
        const kept = current.get(threadId) ?? [];
        const inputHash = hashToolInput(input);
        const sameTool = kept.flatMap((entry, index) =>
          entry.toolName === toolName ? [index] : [],
        );
        const exact = sameTool.filter((index) => kept[index]?.inputHash === inputHash);
        // Identical invocations can produce different task IDs. Leave ambiguous results unclaimed.
        const index =
          exact.length === 1
            ? exact[0]!
            : exact.length === 0 &&
                options?.exact !== true &&
                toolName !== "delegate_task" &&
                sameTool.length === 1
              ? sameTool[0]!
              : -1;
        if (index === -1) {
          return [undefined, current];
        }
        const rest = kept.filter((_, keptIndex) => keptIndex !== index);
        const next = new Map(current);
        if (rest.length === 0) {
          next.delete(threadId);
        } else {
          next.set(threadId, rest);
        }
        return [kept[index]!.output, next];
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
