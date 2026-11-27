import { describe, expect, it } from "@effect/vitest";

import {
  faviconUrlForOrigin,
  toolActivityFaviconUrl,
  WEBSITE_LETTER_TILE_HUES,
  websiteLetterTile,
} from "./favicon.ts";

describe("faviconUrlForOrigin", () => {
  it.each([
    "http://192.168.1.10:8080",
    "http://localhost:3000",
    "http://home.arpa",
    "https://printer.local.",
    "https://api.internal",
    "https://box.tailnet.ts.net",
    "http://127.1",
    "http://0x7f000001",
    "http://[::]",
    "http://[::1]",
    "http://[::ffff:192.168.1.10]",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://100.64.0.1",
    "http://198.51.100.1",
    "http://[2001:db8::1]",
    "http://service.test",
    "http://private.onion",
    "http://127.1..",
    "https://grafana.corp",
    "https://build.lan",
    "https://wiki.intranet",
    "https://grafana.internal.acme-corp.com",
    "https://jira.corp.acme-corp.com:8443",
  ])("does not disclose %s to the favicon provider", (origin) => {
    expect(faviconUrlForOrigin(origin)).toBeNull();
  });

  it("sends only the public hostname and requested size, never the port", () => {
    expect(faviconUrlForOrigin("https://github.com:8443/pingdotgg/t3code?private=query", 64)).toBe(
      "https://www.google.com/s2/favicons?domain=github.com&sz=64",
    );
  });

  it.each([null, undefined, "", "invalid URL", "file:///tmp/private", "data:text/plain,private"])(
    "rejects an invalid or unsupported origin %s",
    (origin) => {
      expect(faviconUrlForOrigin(origin)).toBeNull();
    },
  );
});

describe("toolActivityFaviconUrl", () => {
  it("uses the page origin instead of a third-party favicon service", () => {
    expect(toolActivityFaviconUrl({ pageUrl: "https://example.com/docs/page?q=1" }, "light")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(toolActivityFaviconUrl({ pageUrl: "http://localhost:5173/app" }, "light")).toBe(
      "http://localhost:5173/favicon.ico",
    );
  });

  it("selects site-owned light and dark variants without filtering full-color icons", () => {
    expect(toolActivityFaviconUrl({ pageUrl: "https://github.com/openai/codex" }, "light")).toBe(
      "https://github.githubassets.com/favicons/favicon.svg",
    );
    expect(toolActivityFaviconUrl({ pageUrl: "https://github.com/openai/codex" }, "dark")).toBe(
      "https://github.githubassets.com/favicons/favicon-dark.svg",
    );

    const fullColorIcon = {
      pageUrl: "https://example.com/docs",
      faviconUrl: "https://cdn.example.com/full-color.png",
    };
    expect(toolActivityFaviconUrl(fullColorIcon, "light")).toBe(fullColorIcon.faviconUrl);
    expect(toolActivityFaviconUrl(fullColorIcon, "dark")).toBe(fullColorIcon.faviconUrl);
  });

  it("prefers a provider-supplied dark favicon", () => {
    expect(
      toolActivityFaviconUrl(
        {
          pageUrl: "https://example.com/docs",
          faviconUrl: "https://example.com/light.svg",
          faviconUrlDark: "https://example.com/dark.svg",
        },
        "dark",
      ),
    ).toBe("https://example.com/dark.svg");
  });

  it("accepts provider-supplied image URLs but rejects extension URLs", () => {
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "https://example.com/icon.png" },
        "light",
      ),
    ).toBe("https://example.com/icon.png");
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "chrome-extension://example/_favicon/" },
        "light",
      ),
    ).toBe("https://example.com/favicon.ico");
  });
});

describe("websiteLetterTile", () => {
  it("takes the site's first letter and ignores www, scheme, path, and case", () => {
    expect(websiteLetterTile("https://www.example.com/a?b=c")?.letter).toBe("E");
    expect(websiteLetterTile("docs.python.org")?.letter).toBe("P");
    expect(websiteLetterTile("https://developer.mozilla.org/en-US/")?.letter).toBe("M");
    expect(websiteLetterTile("www.bbc.co.uk")?.letter).toBe("B");
    expect(websiteLetterTile("http://192.168.1.10:8080")?.letter).toBe("1");
    expect(websiteLetterTile("docs.python.org")).toEqual(websiteLetterTile("python.org"));
    expect(websiteLetterTile("https://www.Example.com")).toEqual(websiteLetterTile("example.com"));
  });

  it("picks one of eight muted hues, stable for a hostname", () => {
    const backgrounds = new Set(
      ["github.com", "google.com", "npmjs.com", "x.com", "apple.com", "vercel.com", "a.io"].map(
        (host) => websiteLetterTile(host)?.background,
      ),
    );
    expect(backgrounds.size).toBeGreaterThan(1);
    for (const background of backgrounds) {
      expect(background).toMatch(
        new RegExp(`^hsl\\((${WEBSITE_LETTER_TILE_HUES.join("|")}), 22%, 40%\\)$`),
      );
    }
    expect(websiteLetterTile("github.com")).toEqual(websiteLetterTile("github.com"));
  });

  it("keeps a white letter at WCAG AA contrast on every hue", () => {
    const channel = (value: number) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    for (const hue of WEBSITE_LETTER_TILE_HUES) {
      // hsl(hue, 22%, 40%) to linear RGB.
      const chroma = (1 - Math.abs(2 * 0.4 - 1)) * 0.22;
      const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
      const m = 0.4 - chroma / 2;
      const [r, g, b] = [
        [chroma, x, 0],
        [x, chroma, 0],
        [0, chroma, x],
        [0, x, chroma],
        [x, 0, chroma],
        [chroma, 0, x],
      ][Math.floor(hue / 60) % 6]!.map((value) => channel(value + m));
      const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("returns null without a hostname", () => {
    expect(websiteLetterTile(null)).toBeNull();
    expect(websiteLetterTile("")).toBeNull();
    expect(websiteLetterTile("https://")).toBeNull();
  });
});
