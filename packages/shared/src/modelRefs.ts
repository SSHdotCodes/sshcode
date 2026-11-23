/**
 * A model someone pasted to add to a harness: an OpenRouter or Hugging Face page, or an id.
 * The model list offers "Add <id> to <harness>" for these when nothing matches the search.
 */
export interface ModelRef {
  /** Where the id comes from; "id" when only `vendor/model` was given. */
  readonly source: "openrouter" | "huggingface" | "id";
  /** `vendor/model`, as the source names it (OpenRouter keeps a `:variant` suffix). */
  readonly id: string;
}

// OpenRouter pages that are not models.
const OPENROUTER_RESERVED = new Set([
  "about",
  "activity",
  "announcements",
  "api",
  "apps",
  "careers",
  "chat",
  "compare",
  "credits",
  "docs",
  "enterprise",
  "keys",
  "models",
  "pricing",
  "privacy",
  "provider",
  "providers",
  "rankings",
  "settings",
  "sign-in",
  "terms",
  "works-with-openrouter",
]);

// Hugging Face pages that are not a model repo.
const HUGGINGFACE_RESERVED = new Set([
  "api",
  "blog",
  "collections",
  "datasets",
  "docs",
  "join",
  "learn",
  "login",
  "models",
  "new",
  "organizations",
  "papers",
  "posts",
  "pricing",
  "settings",
  "spaces",
  "tasks",
]);

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function pathOf(text: string, hosts: ReadonlyArray<string>): string[] | null {
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!hosts.includes(host)) return null;
  return url.pathname.split("/").filter((part) => part.length > 0);
}

function pair(vendor: string | undefined, model: string | undefined): string | null {
  if (vendor === undefined || model === undefined) return null;
  return SEGMENT.test(vendor) && MODEL_SEGMENT.test(model) ? `${vendor}/${model}` : null;
}

export function parseModelRef(input: string): ModelRef | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 300 || /\s/.test(text)) return null;

  const openRouterPath = pathOf(text, ["openrouter.ai"]);
  if (openRouterPath !== null) {
    const [vendor, model] = openRouterPath;
    if (vendor === undefined || OPENROUTER_RESERVED.has(vendor.toLowerCase())) return null;
    const id = pair(vendor, model);
    return id === null ? null : { source: "openrouter", id };
  }

  const huggingFacePath = pathOf(text, ["huggingface.co", "hf.co"]);
  if (huggingFacePath !== null) {
    const [org, model] = huggingFacePath;
    if (org === undefined || HUGGINGFACE_RESERVED.has(org.toLowerCase())) return null;
    const id = pair(org, model);
    return id === null ? null : { source: "huggingface", id };
  }

  // Not a URL: `openrouter/vendor/model` or `vendor/model`.
  if (text.includes("://") || text.includes(".ai/") || text.includes(".co/")) return null;
  const parts = text.split("/");
  if (parts.length === 3 && parts[0]?.toLowerCase() === "openrouter") {
    const id = pair(parts[1], parts[2]);
    return id === null ? null : { source: "openrouter", id };
  }
  if (parts.length === 2) {
    const id = pair(parts[0], parts[1]);
    return id === null ? null : { source: "id", id };
  }
  return null;
}

/** A harness as the model list knows it: enough to say whether models can be added to it. */
export interface ModelManagerHarness {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
}

/** Harnesses that take any model through their own config, even while off in SSHCode. */
const GENERAL_DRIVERS = new Set(["opencode", "pi"]);

/** Harnesses a model can be added to: local ones that are on, plus Pi or OpenCode when off. */
export function canAddModelsTo(harness: ModelManagerHarness): boolean {
  return harness.enabled || GENERAL_DRIVERS.has(harness.driver);
}

/** The harness a request goes to first: the one being browsed, else the first general one. */
export function defaultModelManagerHarness<H extends ModelManagerHarness>(
  harnesses: ReadonlyArray<H>,
  browsing: string | null,
): H["instanceId"] | null {
  return (
    harnesses.find((harness) => harness.instanceId === browsing)?.instanceId ??
    harnesses.find((harness) => harness.enabled && GENERAL_DRIVERS.has(harness.driver))
      ?.instanceId ??
    harnesses[0]?.instanceId ??
    null
  );
}

/** What the Models chat is asked: a pasted id or URL means "add it". */
export function modelManagerRequestText(text: string): string {
  const trimmed = text.trim();
  return parseModelRef(trimmed) === null ? trimmed : `Add ${trimmed}`;
}

/** The model a search names when no listed model is it, so the list can offer to add it. */
export function unlistedSearchedModel(
  query: string,
  slugs: Iterable<string>,
): { readonly ref: ModelRef; readonly query: string } | null {
  const ref = parseModelRef(query);
  if (ref === null) return null;
  for (const slug of slugs) {
    if (slug === ref.id || slug.endsWith(`/${ref.id}`)) return null;
  }
  return { ref, query: query.trim() };
}
