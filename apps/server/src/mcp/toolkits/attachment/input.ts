import { ChatFileAttachment, ChatImageAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Screenshot provenance is app-owned. Existing attachments recover it from stored
// metadata; exposing its recursive accessibility tree breaks model tool schemas.
// Full-size originals are app-owned too: only the composer keeps one.
export const McpAttachmentInput = Schema.Union([
  ChatImageAttachment.mapFields(Struct.omit(["source", "original", "sentSize"])),
  ChatFileAttachment,
]);
