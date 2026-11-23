import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  copiedComposerAttachmentFile,
  rememberCopiedComposerAttachments,
} from "./copiedComposerAttachments";

describe("copied composer attachments", () => {
  it("keeps local bytes for the latest copy, scoped to its environment", () => {
    const source = EnvironmentId.make("source");
    const other = EnvironmentId.make("other");
    const file = new File(["image"], "image.png", { type: "image/png" });
    rememberCopiedComposerAttachments(source, new Map([["local-id", file]]));
    expect(copiedComposerAttachmentFile(source, "local-id")).toBe(file);
    expect(copiedComposerAttachmentFile(other, "local-id")).toBeUndefined();
    rememberCopiedComposerAttachments(other, new Map());
    expect(copiedComposerAttachmentFile(source, "local-id")).toBeUndefined();
  });
});
