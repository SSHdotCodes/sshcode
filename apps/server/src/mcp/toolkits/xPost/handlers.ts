import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { renderPost } from "../../../xPost/normalize.ts";
import * as XPostReader from "../../../xPost/XPostReader.ts";
import * as XSearch from "../../../xPost/XSearch.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { XPostToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(XPostToolkit, {
  read_x_post: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const reader = yield* XPostReader.XPostReader;
      const { images, earlier, limits, ...post } = yield* reader.read(input).pipe(
        Effect.catchTags({
          XPostReadError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: error.reason === "invalid_url" ? "invalid_request" : "orchestration_error",
                message: error.message,
              }),
            ),
        }),
      );
      return {
        url: post.url,
        post: [
          ...(earlier ?? []).map((before) => `Earlier:\n${renderPost(before)}`),
          renderPost(post),
          post.url,
          limits,
        ].join("\n\n"),
        ...(images === undefined ? {} : { images }),
      };
    }),
  ),
  search_x: McpToolAccess.reads(({ query, deep }) =>
    Effect.gen(function* () {
      const text = query.trim();
      if (text.length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Say what to search X for.",
        });
      }
      const search = yield* XSearch.XSearch;
      const posts = yield* search
        .search(text, deep)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      return { posts };
    }),
  ),
});
