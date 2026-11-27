import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as XPostReader from "../../../xPost/XPostReader.ts";
import { XPostInput, XPostToolResult, XSearchToolResult } from "../../../xPost/schema.ts";
import * as XSearch from "../../../xPost/XSearch.ts";

const ReadXPostTool = Tool.make("read_x_post", {
  description:
    "Read an X (Twitter) post from its link: text, author, media, quoted post and earlier posts in its thread. Use it when the user sends an x.com or twitter.com link.",
  parameters: Schema.Struct({
    ...XPostInput.fields,
    includeImages: Schema.optional(
      Schema.Boolean.annotate({
        description: "Return up to 4 photos as image content. Default false.",
      }),
    ),
    thread: Schema.optional(
      Schema.Boolean.annotate({
        description: "Include earlier replies, up to 8 hops. Default true.",
      }),
    ),
  }),
  success: XPostToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [XPostReader.XPostReader],
})
  .annotate(Tool.Title, "Read X post")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const SearchXTool = Tool.make("search_x", {
  description: "Search X (Twitter) posts. Defaults to the last 7 days.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: 'Keywords or X operators, e.g. from:user "exact phrase" since:2026-11-01.',
    }),
    deep: Schema.optional(Schema.Boolean.annotate({ description: "All dates (slower)." })),
  }),
  success: XSearchToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [XSearch.XSearch],
})
  .annotate(Tool.Title, "Search X")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const XPostToolkit = Toolkit.make(ReadXPostTool, SearchXTool);
