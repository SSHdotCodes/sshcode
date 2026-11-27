import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * A link that opens one Settings page from outside the sheet (Home, a chat, the palette)
 * must keep Settings beneath it (`initial: false`). Otherwise the page becomes the sheet's
 * first screen, which has no back or close button. Links from inside Settings push onto the
 * open stack and need nothing.
 */
const SOURCE_ROOT = NodePath.resolve(__dirname, "../..");
const SETTINGS_ROOT = NodePath.join(SOURCE_ROOT, "features/settings");

function sourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The nested `params: { screen: ... }` object after each `screen: "SettingsContent"`. */
function settingsPageLinks(source: string): string[] {
  const links: string[] = [];
  const pattern = /screen:\s*"SettingsContent",?\s*params:\s*\{/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    links.push(source.slice(match.index + match[0].length - 1, index));
  }
  return links;
}

describe("links into Settings from outside the sheet", () => {
  it("keep Settings beneath the page they open", () => {
    const missing = sourceFiles(SOURCE_ROOT)
      .filter((file) => !file.startsWith(SETTINGS_ROOT + NodePath.sep))
      .flatMap((file) =>
        settingsPageLinks(NodeFS.readFileSync(file, "utf8"))
          // Opening Settings itself is already its first screen.
          .filter((link) => !/^\{\s*screen:\s*"Settings"\s*\}$/.test(link))
          .filter((link) => !/initial:\s*false/.test(link))
          .map((link) => `${NodePath.relative(SOURCE_ROOT, file)}: ${link.replace(/\s+/g, " ")}`),
      );
    expect(missing).toEqual([]);
  });
});
