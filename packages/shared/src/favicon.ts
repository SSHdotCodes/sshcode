import { isPublicFaviconHost } from "./hostClassification.ts";

/**
 * Mirrors Codex's generic Browser Use fallback: ask the page origin for its
 * conventional favicon and let the image element fall back to a browser glyph.
 * Chrome-backed tools can pass their tab's explicit favicon URL separately.
 */
function faviconUrlForPage(rawUrl: string | null | undefined, _size = 32): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return new URL("/favicon.ico", pageUrl.origin).href;
  } catch {
    return null;
  }
}

const THEMED_FAVICON_BY_HOSTNAME: Readonly<
  Record<string, Readonly<{ light: string; dark: string }>>
> = {
  "github.com": {
    light: "https://github.githubassets.com/favicons/favicon.svg",
    dark: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
};

function themedFaviconUrlForPage(
  rawUrl: string | null | undefined,
  appearance: "light" | "dark",
): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return THEMED_FAVICON_BY_HOSTNAME[pageUrl.hostname.toLowerCase()]?.[appearance] ?? null;
  } catch {
    return null;
  }
}

/** Accepts image URLs supplied by a trusted provider event. */
function explicitFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Chooses a website icon for the app's resolved theme. Provider-supplied
 * variants mirror Codex's Chrome-selected favicon path. A small site-owned
 * fallback table covers websites whose conventional favicon is illegible in
 * one appearance without recoloring full-color icons.
 */
export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  size = 32,
): string | null {
  if (appearance === "dark") {
    return (
      explicitFaviconUrl(icon.faviconUrlDark) ??
      themedFaviconUrlForPage(icon.pageUrl, "dark") ??
      explicitFaviconUrl(icon.faviconUrl) ??
      faviconUrlForPage(icon.pageUrl, size)
    );
  }
  return (
    explicitFaviconUrl(icon.faviconUrl) ??
    themedFaviconUrlForPage(icon.pageUrl, "light") ??
    faviconUrlForPage(icon.pageUrl, size)
  );
}

/**
 * Return a public favicon URL that discloses only a public hostname, never the
 * port, path, or a private or internal-looking host. Callers show a generic
 * icon when this returns null.
 */
export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPublicFaviconHost(url.hostname)) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=${size}`;
  } catch {
    return null;
  }
}

/**
 * Eight evenly spaced hues for letter tiles. Low saturation and a middle
 * lightness keep a white letter readable on both light and dark surfaces.
 */
export const WEBSITE_LETTER_TILE_HUES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/**
 * The name a person knows the site by: `python` for docs.python.org, `bbc` for
 * www.bbc.co.uk. A bare name or an IP address stays whole.
 */
function siteName(hostname: string): string {
  const labels = hostname.split(".").filter((label) => label !== "");
  if (labels.length < 2 || /^[\d.]+$/u.test(hostname)) return hostname;
  const last = labels.length - 1;
  const countryCodeSecondLevel =
    labels.length >= 3 &&
    labels[last]!.length === 2 &&
    SECOND_LEVEL_SUFFIXES.has(labels[last - 1]!);
  return labels[countryCodeSecondLevel ? last - 2 : last - 1]!;
}

function siteHostname(rawUrlOrHost: string): string | null {
  const trimmed = rawUrlOrHost.trim();
  if (trimmed === "" || trimmed.length > 4096) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}

/**
 * The icon shown in place of a website icon when Website icons is off, built
 * without any network request: the first letter of the site's name on one of
 * eight muted hues picked by a stable hash of that name, so a site's
 * subdomains share one tile. Null when the input has no
 * hostname; callers keep their generic glyph then.
 */
export function websiteLetterTile(
  rawUrlOrHost: string | null | undefined,
): { readonly letter: string; readonly background: string } | null {
  if (!rawUrlOrHost) return null;
  const hostname = siteHostname(rawUrlOrHost);
  if (hostname === null) return null;
  const name = siteName(hostname);
  const letter = /[\p{L}\p{N}]/u.exec(name)?.[0]?.toUpperCase();
  if (letter === undefined) return null;
  // FNV-1a: stable across clients and sessions, so a site keeps its color everywhere.
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hue = WEBSITE_LETTER_TILE_HUES[hash % WEBSITE_LETTER_TILE_HUES.length];
  return { letter, background: `hsl(${hue}, 22%, 40%)` };
}
