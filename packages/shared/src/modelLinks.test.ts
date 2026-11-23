import { describe, expect, it } from "vite-plus/test";
import {
  collectModelLinks,
  formatModelLink,
  formatModelLinkHref,
  parseModelLinkHref,
} from "./modelLinks.ts";
import { extractMarkdownLinkHrefs } from "./markdownLinks.ts";

describe("model links", () => {
  it.each([
    ["muse", "ember"],
    ["instance/with %?#!'()*", "qwen-latest-series-invite-1102(openai)"],
    ["日本語", "org/model !*'() [] \\ % /?é"],
    ["literal%2F", "literal%252F"],
  ])("round trips each encoded segment: %s / %s", (instanceId, model) => {
    const href = formatModelLinkHref(instanceId, model);
    expect(parseModelLinkHref(href)).toEqual({ instanceId, model });
    expect(href.slice("t3-model://v1/".length)).not.toMatch(/[()'!*\s?#]/);
    expect(extractMarkdownLinkHrefs(formatModelLink(instanceId, model, "Muse Ember"))).toEqual([
      href,
    ]);
  });

  it.each([
    "t3-model://v2/a/b",
    "t3-model://v1//b",
    "t3-model://v1/a/",
    "t3-model://v1/a/b/c",
    "t3-model://v1/a/%broken",
    "t3-model://v1/a/b?c",
  ])("rejects invalid destinations: %s", (href) => {
    expect(parseModelLinkHref(href)).toBeNull();
  });

  it("retains a missing model's written label and skips examples in code", () => {
    const source = formatModelLink("gone", "unknown", "Muse [Ember] \\ test");
    const text = `use ${source}, then \`${source}\`\n\`\`\`\n${source}\n\`\`\``;
    expect(collectModelLinks(text)).toEqual([
      {
        instanceId: "gone",
        model: "unknown",
        label: "Muse [Ember] \\ test",
        source,
        start: 4,
        end: 4 + source.length,
      },
    ]);
  });
});
