/** A model reference is scoped to the environment containing the message. */
export const MODEL_LINK_PROTOCOL = "t3-model";
const PREFIX = `${MODEL_LINK_PROTOCOL}://v1/`;

function encodeSegment(id: string): string {
  return encodeURIComponent(id).replace(
    /[()'!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function formatModelLinkHref(instanceId: string, model: string): string {
  return `${PREFIX}${encodeSegment(instanceId)}/${encodeSegment(model)}`;
}

export function parseModelLinkHref(href: string): { instanceId: string; model: string } | null {
  if (!href.startsWith(PREFIX)) return null;
  const segments = href.slice(PREFIX.length).split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment || /[\s?#()'!*]/u.test(segment)))
    return null;
  try {
    const instanceId = decodeURIComponent(segments[0]!);
    const model = decodeURIComponent(segments[1]!);
    return instanceId && model ? { instanceId, model } : null;
  } catch {
    return null;
  }
}

export function formatModelLink(instanceId: string, model: string, label: string): string {
  const escaped = (label || model).replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, "\\$&");
  return `[${escaped}](${formatModelLinkHref(instanceId, model)})`;
}

// Code is consumed first, so examples inside fences and spans remain literal.
// Groups are read by number: `matchAll` on the phone's JavaScript engine
// (Hermes) drops named groups, which left the phone without model chips.
const MODEL_LINKS =
  /((`{3,}|~{3,})[\s\S]*?(?:\2|$))|((`+)[^\n]*?\4)|\[((?:\\.|[^\]\\\n]){0,512})\]\((t3-model:\/\/v1\/[^\s)]+)\)/g;
const LABEL_GROUP = 5;
const HREF_GROUP = 6;

export function collectModelLinks(text: string) {
  if (!text.includes("t3-model://v1/")) return [];
  return [...text.matchAll(MODEL_LINKS)].flatMap((match) => {
    const href = match[HREF_GROUP];
    const target = href ? parseModelLinkHref(href) : null;
    return target
      ? [
          {
            ...target,
            label: (match[LABEL_GROUP] ?? "").replace(/\\(.)/g, "$1"),
            source: match[0],
            start: match.index,
            end: match.index + match[0].length,
          },
        ]
      : [];
  });
}
