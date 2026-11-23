import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
  toolOutputImageBlocks,
} from "@t3tools/shared/toolOutput";

const IMAGE_MIME_KEYS = ["mimeType", "mime_type", "media_type", "type"] as const;
const IMAGE_BODY_KEYS = new Set(["data", "blob", "base64"]);
const MAX_DEPTH = 32;
// Shorter strings are identifiers or tiny fixtures, not pixels worth removing.
const MIN_BODY_LENGTH = 64;
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;

type UnknownRecord = Record<string, unknown>;

function hasImageMime(record: UnknownRecord): boolean {
  return IMAGE_MIME_KEYS.some((key) => {
    const mime = record[key];
    return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
  });
}

/**
 * The record that carries an image's bytes: an MCP or ACP `type: "image"`
 * block, Cursor's `image` part (its mime type is optional), or a record with
 * an `image/*` mime field such as Claude's `source`, the `file` of Claude's
 * structured Read result, and Grok's `ImageContent`.
 */
function isImageBody(record: UnknownRecord, key: string | undefined): boolean {
  if (record.type === "image" || key === "image") return true;
  if (!hasImageMime(record)) return false;
  return (
    record.type === undefined ||
    record.type === "base64" ||
    (typeof record.type === "string" && record.type.toLowerCase().startsWith("image/"))
  );
}

function isBase64Body(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_BODY_LENGTH && BASE64_BODY.test(value);
}

function base64DecodedLength(encoded: string): number {
  let length = encoded.length;
  while (length > 0 && encoded.charCodeAt(length - 1) === 0x3d /* = */) {
    length -= 1;
  }
  return Math.floor((length * 3) / 4);
}

interface StripContext {
  readonly output: unknown;
  served: ReadonlyArray<unknown> | undefined;
}

/** A block the asset route serves: in a served position and within its size limit. */
function isServed(context: StripContext, record: UnknownRecord): boolean {
  context.served ??= toolOutputImageBlocks(context.output);
  if (!context.served.includes(record)) return false;
  const data = readToolOutputImage(record)?.data;
  return data === undefined || data.length <= MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH;
}

function strip(
  value: unknown,
  key: string | undefined,
  context: StripContext,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    let next: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const stripped = strip(entry, undefined, context, depth + 1);
      if (stripped !== entry) {
        next ??= value.slice();
        next[index] = stripped;
      }
    }
    return next ?? value;
  }
  const record = value as UnknownRecord;
  // Every served block is a `type: "image"` block; keep it whole.
  if (record.type === "image" && isServed(context, record)) return record;
  const image = readToolOutputImage(record);
  const unavailable =
    image?.data !== undefined && image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH;
  const imageBody = isImageBody(record, key);
  let next: UnknownRecord | undefined;
  let removedBody: string | undefined;
  for (const entryKey in record) {
    if (!Object.hasOwn(record, entryKey)) continue;
    const entry = record[entryKey];
    if (imageBody && IMAGE_BODY_KEYS.has(entryKey) && isBase64Body(entry)) {
      next ??= { ...record };
      delete next[entryKey];
      removedBody = entry;
      continue;
    }
    const stripped = strip(entry, entryKey, context, depth + 1);
    if (stripped !== entry) {
      next ??= { ...record };
      next[entryKey] = stripped;
    }
  }
  if (next !== undefined && removedBody !== undefined) {
    // Measured from the removed body, never taken from a provider's size field.
    next.sizeBytes = base64DecodedLength(removedBody);
  }
  if (unavailable && next !== undefined) next.imageUnavailable = true;
  return next ?? record;
}

/**
 * Replaces the base64 image bodies in a dynamic tool's output with their
 * decoded byte size, except the blocks a `tool-output-image` asset serves.
 *
 * Tools that read or capture an image return the whole file as base64, and a
 * turn item is stored twice: in the event log and in the projection. Only the
 * blocks `toolOutputImageBlocks` finds, within the asset size limit, are ever
 * read back; previews of a read file load from `viewedImagePath`, and context
 * handoff skips tool items.
 * Strings that are not a base64 body are kept, so identifiers and inline SVG
 * under the same keys survive. Containers are copied only when a descendant
 * changes; an item without such bytes is returned by reference.
 */
export function stripUnservedToolOutputImageBytes(
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool" || typeof item.output !== "object" || item.output === null) {
    return item;
  }
  const output = strip(item.output, undefined, { output: item.output, served: undefined }, 0);
  return output === item.output ? item : { ...item, output };
}

// Read and view tools across harnesses: `Read` (Claude, ACP agents, Cursor), `read`
// (OpenCode, Pi), Grok's `ReadFile`, `view_image` and the like. MCP prefixes drop.
const READ_TOOL_NAMES = new Set(["read", "readfile", "readimage", "viewimage", "viewfile", "view"]);
const READ_PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "target_file",
  "absolute_path",
  "absolutePath",
  "AbsolutePath",
  "image_path",
  "imagePath",
  "file",
] as const;

/**
 * Marks a read of an image file with `viewedImagePath`, so the chat shows the
 * picture the agent looked at. Claude's and Codex's adapters set it themselves;
 * other harnesses report only a read tool and the path in its input.
 */
export function withViewedImagePath(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (
    item.type !== "dynamic_tool" ||
    item.viewedImagePath !== undefined ||
    item.status === "failed" ||
    item.toolName === null ||
    typeof item.input !== "object" ||
    item.input === null ||
    Array.isArray(item.input)
  ) {
    return item;
  }
  const name = (item.toolName.split("__").at(-1) ?? item.toolName)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!READ_TOOL_NAMES.has(name)) return item;
  const input = item.input as UnknownRecord;
  for (const key of READ_PATH_KEYS) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const path = value.trim();
    if (
      path.length > 0 &&
      path.length <= 4096 &&
      !/[\r\n]/.test(path) &&
      isWorkspaceImagePreviewPath(path)
    ) {
      return { ...item, viewedImagePath: path };
    }
  }
  return item;
}
