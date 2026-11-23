import { describe, expect, it } from "vite-plus/test";
import {
  collectGithubLinks,
  compactGithubMarkdownLinks,
  parseGithubLink,
  parseHuggingFaceLink,
  parseLinkChip,
} from "./githubLinks.js";

describe("parseGithubLink", () => {
  it.each([
    ["https://github.com/BetterWright/betterwright", "BetterWright/betterwright"],
    ["https://github.com/owner/repo/", "owner/repo"],
    ["https://github.com/owner/repo.git?tab=readme#readme", "owner/repo"],
    ["https://github.com/owner/repo/pull/239/files", "owner/repo#239"],
    ["https://github.com/owner/repo/issues/42", "owner/repo#42"],
    ["https://github.com/owner/repo/tree/main", "owner/repo › main"],
    ["https://github.com/owner/repo/blob/main/src/file.ts", "owner/repo › main/src/file.ts"],
    ["https://github.com/owner/repo/commit/abcdef123456789", "owner/repo › abcdef1"],
  ])("labels %s", (url, label) => expect(parseGithubLink(url)).toEqual({ label }));

  it.each([
    "https://github.com/owner",
    "https://github.com.evil.test/owner/repo",
    "https://evil.test/github.com/owner/repo",
    "https://user@github.com/owner/repo",
    "ftp://github.com/owner/repo",
    "https://github.com/owner/repo extra",
  ])("rejects %s", (url) => expect(parseGithubLink(url)).toBeNull());
});

it("collects complete standalone URLs, preserving their exact source", () => {
  const url = "https://github.com/Owner/Repo.git?q=One%20Two#readme";
  expect(collectGithubLinks(`see ${url} next`)).toEqual([
    { type: "github-link", start: 4, end: 4 + url.length, source: url, label: "Owner/Repo" },
  ]);
  expect(collectGithubLinks(url)).toHaveLength(1);
  expect(collectGithubLinks(url, false)).toEqual([]);
  expect(collectGithubLinks(`${url} `, false)).toHaveLength(1);
  expect(collectGithubLinks(`[custom](${url})`)).toEqual([]);
  expect(collectGithubLinks(`\`${url}\`\n\`\`\`\n${url}\n\`\`\``)).toEqual([]);
});

it("compacts bare and URL-labelled markdown links without changing authored labels or code", () => {
  const url = "https://github.com/owner/repo/pull/239";
  const compact = `[owner/repo#239](<${url}>)`;
  const markdown = `${url} [${url}](${url}) [release pr #239](${url}) \`${url}\`\n\n\`\`\`\n${url}\n\`\`\``;
  expect(compactGithubMarkdownLinks(markdown)).toBe(
    `${compact} ${compact} [release pr #239](${url}) \`${url}\`\n\n\`\`\`\n${url}\n\`\`\``,
  );
});

describe("parseHuggingFaceLink", () => {
  it.each([
    ["https://huggingface.co/ProCreations/grug-27b", "ProCreations/grug-27b"],
    ["https://hf.co/ProCreations/grug-27b?library=transformers", "ProCreations/grug-27b"],
    ["https://huggingface.co/datasets/owner/web-data", "owner/web-data · dataset"],
    ["https://huggingface.co/spaces/owner/demo", "owner/demo · Space"],
    ["https://huggingface.co/owner/model/blob/main/config.json", "owner/model › config.json"],
    ["https://huggingface.co/owner/model/tree/main/onnx", "owner/model › onnx"],
    ["https://huggingface.co/papers/2401.12345", "Paper 2401.12345"],
    ["https://huggingface.co/ProCreations", "ProCreations"],
  ])("labels %s", (url, label) => expect(parseHuggingFaceLink(url)).toEqual({ label }));

  it.each([
    "https://huggingface.co/",
    "https://huggingface.co/models",
    "https://huggingface.co/docs/transformers",
    "https://huggingface.co/datasets",
    "https://huggingface.co.evil.test/owner/model",
    "https://user@huggingface.co/owner/model",
    "https://huggingface.co/papers/not-a-paper",
  ])("rejects %s", (url) => expect(parseHuggingFaceLink(url)).toBeNull());

  it("names the site so the chip can show its mark", () => {
    expect(parseLinkChip("https://huggingface.co/owner/model")?.site).toBe("huggingface");
    expect(parseLinkChip("https://github.com/owner/repo")?.site).toBe("github");
    expect(parseLinkChip("https://example.com/owner/repo")).toBeNull();
  });

  it("becomes a chip in the composer and compacts in markdown like GitHub links", () => {
    const url = "https://huggingface.co/ProCreations/grug-27b";
    expect(collectGithubLinks(`${url} `, false)).toEqual([
      {
        type: "github-link",
        start: 0,
        end: url.length,
        source: url,
        label: "ProCreations/grug-27b",
      },
    ]);
    expect(compactGithubMarkdownLinks(url)).toBe(`[ProCreations/grug-27b](<${url}>)`);
  });
});
