import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import { XPostToolResult, XSearchToolResult } from "../../../xPost/schema.ts";

const decodeResult = Schema.decodeUnknownOption(XPostToolResult);
const decodeSearch = Schema.decodeUnknownOption(XSearchToolResult);

/**
 * The post is plain text for the model, and image bytes leave structured content so
 * text-only harnesses see no image envelope.
 */
export function presentXPost(
  _name: string,
  result: McpSchema.CallToolResult,
): McpSchema.CallToolResult {
  const search = decodeSearch(result.structuredContent);
  if (Option.isSome(search)) {
    return new McpSchema.CallToolResult({
      isError: false,
      structuredContent: search.value,
      content: [{ type: "text", text: search.value.posts }],
    });
  }
  const decoded = decodeResult(result.structuredContent);
  if (Option.isNone(decoded)) return result;
  const { images, ...post } = decoded.value;
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: post,
    content: [
      { type: "text", text: post.post },
      ...(images ?? []).map((image) => ({
        type: "image" as const,
        data: new Uint8Array(Buffer.from(image.data, "base64")),
        mimeType: image.mimeType,
      })),
    ],
  });
}
