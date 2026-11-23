import type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "../components/FilePreviewModal.types";

export function filePreviewKey(source: FilePreviewItem): string {
  if (source.occurrenceId) return `occurrence:${source.occurrenceId}`;
  if ("resource" in source)
    return JSON.stringify([
      source.environmentId,
      Object.entries(source.resource)
        .filter(([key]) => key !== "mimeType" && key !== "fileName")
        .sort(([a], [b]) => a.localeCompare(b)),
    ]);
  if ("attachment" in source) return `attachment:${source.attachment.id}`;
  return source.uri;
}

/** Preserve document order and the tapped image's transition source. */
export function filePreviewGallery(source: FilePreviewSource, group: readonly FilePreviewItem[]) {
  if (source.kind !== "image" && !(source.kind === "video" && source.gallery)) return [source];
  const selectedKey = filePreviewKey(source);
  const seen = new Set<string>();
  const items: FilePreviewItem[] = [];
  for (const item of source.gallery ?? group) {
    if (item.kind !== "image" && !(source.gallery && item.kind === "video")) continue;
    const key = filePreviewKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(key === selectedKey ? source : item);
  }
  if (!seen.has(selectedKey)) items.unshift(source);
  return items;
}

/** Markdown captions are display text, never filenames for native file type detection. */
export function filePreviewName(source: FilePreviewItem): string {
  const uriName = "uri" in source ? source.uri.split(/[?#]/)[0]?.split("/").pop() : undefined;
  const name =
    source.name ?? ("attachment" in source ? source.attachment.name : uriName) ?? "Preview";
  const extension = /\.(png|jpe?g|gif|webp|heic|heif|avif|svg|pdf|docx?|xlsx?|pptx?|txt|rtf)$/i;
  const filename =
    source.kind !== "image" || extension.test(name)
      ? name
      : uriName && extension.test(uriName)
        ? uriName
        : name.replace(/\./g, "_");
  return Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 || "/:\\".includes(character) ? "_" : character,
  ).join("");
}

const SVG_REFERENCE = /\.svg(?:[?#]|$)|^data:image\/svg\+xml/i;

/** In-app image viewers cannot draw SVG; Quick Look can. */
export function isSvgPreview(source: FilePreviewItem | ResolvedFilePreviewSource): boolean {
  const mimeTypes = [source.mimeType, source.actionsSource?.mimeType];
  if (mimeTypes.some((mimeType) => mimeType?.toLowerCase().startsWith("image/svg"))) return true;
  const references = [
    source.name,
    "uri" in source ? source.uri : undefined,
    "resource" in source && "path" in source.resource ? source.resource.path : undefined,
    source.actionsSource?.name,
  ];
  return references.some((reference) => reference !== undefined && SVG_REFERENCE.test(reference));
}

/** Gallery positions whose URLs a viewer resolves ahead of the one on screen. */
export function filePreviewResolutionWindow(index: number, count: number, radius = 2): number[] {
  const start = Math.max(0, index - radius);
  const end = Math.min(count - 1, index + radius);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => start + offset);
}
