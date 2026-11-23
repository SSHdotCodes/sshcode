import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

/** Display metadata only. The source URL always remains the link's identity. */
export function parseGithubLink(source: string): { label: string } | null {
  if (!/^https?:\/\//i.test(source) || /\s/.test(source)) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port)
    return null;
  const [owner, rawRepo, ...path] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (!owner || !repo || !/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  const repository = `${owner}/${repo}`;
  if (path.length === 0) return { label: repository };
  if ((path[0] === "pull" || path[0] === "issues") && /^[1-9]\d*$/.test(path[1] ?? ""))
    return { label: `${repository}#${path[1]}` };
  const detail =
    path[0] === "commit"
      ? path[1]?.slice(0, 7)
      : path[0] === "tree" || path[0] === "blob"
        ? path.slice(1).join("/")
        : path.join("/");
  let decoded = detail || path[0]!;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed escapes still have a useful literal label.
  }
  return {
    label: `${repository} › ${decoded.length > 36 ? `${decoded.slice(0, 20)}…${decoded.slice(-15)}` : decoded}`,
  };
}

// First path segments that are Hugging Face pages, not a user or organization.
const HUGGING_FACE_PAGES = new Set([
  "api",
  "blog",
  "chat",
  "collections",
  "docs",
  "enterprise",
  "join",
  "learn",
  "login",
  "models",
  "new",
  "organizations",
  "posts",
  "pricing",
  "search",
  "settings",
  "tasks",
]);

function shortDetail(path: ReadonlyArray<string>): string {
  let detail = path.join("/");
  try {
    detail = decodeURIComponent(detail);
  } catch {
    // Malformed escapes still have a useful literal label.
  }
  return detail.length > 36 ? `${detail.slice(0, 20)}…${detail.slice(-15)}` : detail;
}

/** A model, dataset, Space, paper or profile on Hugging Face, labelled like a repository. */
export function parseHuggingFaceLink(source: string): { label: string } | null {
  if (!/^https?:\/\//i.test(source) || /\s/.test(source)) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    (host !== "huggingface.co" && host !== "www.huggingface.co" && host !== "hf.co") ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "papers") {
    return /^\d{4}\.\d{4,5}$/.test(segments[1] ?? "") ? { label: `Paper ${segments[1]}` } : null;
  }
  const kind = segments[0] === "datasets" || segments[0] === "spaces" ? segments[0] : null;
  const [owner, name, ...path] = kind ? segments.slice(1) : segments;
  if (!owner || !/^[\w.-]+$/.test(owner) || (!kind && HUGGING_FACE_PAGES.has(owner))) return null;
  if (!name) return kind ? null : { label: owner };
  if (!/^[\w.-]+$/.test(name)) return null;
  const repository = `${owner}/${name}${kind === "datasets" ? " · dataset" : kind === "spaces" ? " · Space" : ""}`;
  // blob/main/config.json and tree/main/onnx name the file or folder, not the revision.
  const detail =
    path[0] === "blob" || path[0] === "tree" || path[0] === "resolve" ? path.slice(2) : path;
  return detail.length === 0
    ? { label: repository }
    : { label: `${repository} › ${shortDetail(detail)}` };
}

export type LinkChipSite = "github" | "huggingface";

/** A URL shown as a site chip (GitHub, Hugging Face) instead of the raw address. */
export function parseLinkChip(source: string): { site: LinkChipSite; label: string } | null {
  const github = parseGithubLink(source);
  if (github) return { site: "github", ...github };
  const huggingFace = parseHuggingFaceLink(source);
  return huggingFace ? { site: "huggingface", ...huggingFace } : null;
}

const LINK_CHIP_HOST = /https?:\/\/(?:github\.com|(?:www\.)?huggingface\.co|hf\.co)\//i;

/** Only standalone, completed URLs become atoms. Live typing waits for whitespace. */
export function collectGithubLinks(text: string, allowEnd = true) {
  const matches: {
    type: "github-link";
    start: number;
    end: number;
    source: string;
    label: string;
  }[] = [];
  const pattern =
    /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\n]*?\2|(?<!\S)https?:\/\/(?:github\.com|(?:www\.)?huggingface\.co|hf\.co)\/[^\s<>"'`[\]]+/gi;
  for (const match of text.matchAll(pattern)) {
    if (match[1] || match[2]) continue;
    const source = match[0];
    const end = match.index + source.length;
    if ((!allowEnd && end === text.length) || /[.,;!)]$/.test(source)) continue;
    const parsed = parseLinkChip(source);
    if (parsed) {
      matches.push({ type: "github-link", start: match.index, end, source, label: parsed.label });
    }
  }
  return matches;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Native link pills are keyed by URL, so relabel individual URL spans before rendering. */
export function compactGithubMarkdownLinks(markdown: string): string {
  if (!LINK_CHIP_HOST.test(markdown)) return markdown;
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (
    node: ReturnType<typeof parser.parse>["children"][number] | ReturnType<typeof parser.parse>,
  ) => {
    if (node.type === "link") {
      const label = node.children
        .map((child) => (child.type === "text" ? child.value : ""))
        .join("");
      const github = label === node.url ? parseLinkChip(node.url) : null;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (github && start !== undefined && end !== undefined) {
        const escaped = github.label.replace(/[\\[\]]/g, "\\$&");
        edits.push({ start, end, text: `[${escaped}](<${node.url}>)` });
      }
      return;
    }
    if (node.type === "linkReference" || node.type === "image" || node.type === "imageReference")
      return;
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(parser.parse(markdown));
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  }
  return markdown;
}
