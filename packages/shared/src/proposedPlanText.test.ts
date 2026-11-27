import { describe, expect, it } from "vite-plus/test";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";

describe("proposedPlanTitle", () => {
  it("reads the first markdown heading as the plan title", () => {
    expect(proposedPlanTitle("# Integrate RPC\n\nBody")).toBe("Integrate RPC");
  });

  it("returns null when the plan has no heading", () => {
    expect(proposedPlanTitle("- step 1")).toBeNull();
  });

  it("takes the plan title from headings outside code", () => {
    for (const [open, inner, close] of [
      ["```bash", "~~~", "```"],
      ["~~~bash", "```", "~~~"],
      ["````bash", "```", "````"],
    ]) {
      const code = `${open}\n# Back up database\n${inner}\n# Still code\n${close}\n`;
      expect(proposedPlanTitle(`${code}\n## Real Plan Title\n`)).toBe("Real Plan Title");
    }
    expect(proposedPlanTitle("```bash\n# Back up database\n")).toBeNull();
    expect(proposedPlanTitle("\t# Back up database\n\n## Real Plan Title")).toBe("Real Plan Title");
  });
});

describe("stripDisplayedPlanMarkdown", () => {
  it("drops the leading title heading from displayed plan markdown", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Summary\n\n- step 1\n")).toBe(
      "- step 1",
    );
  });

  it("preserves non-summary headings after dropping the title heading", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Scope\n\n- step 1\n")).toBe(
      "## Scope\n\n- step 1",
    );
  });

  it("skips empty plan headings without reading into the next line", () => {
    for (const [heading, title] of [
      ["#   \r\n###\t\r\n## ###\r\n## Real Title", "Real Title"],
      ["## # #", "#"],
      ["## ###\t###", "###"],
    ]) {
      const markdown = `${heading}\r\n\r\n## Summary\r\n\r\nBody text`;
      expect(proposedPlanTitle(markdown)).toBe(title);
      expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
    }
  });

  it("strips the displayed plan title and summary after leading blank lines", () => {
    const markdown = "\r\n# My Plan\r\n\r\n## Summary\r\n\r\nBody text";
    expect(proposedPlanTitle(markdown)).toBe("My Plan");
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
  });
});

it("ignores a code fence inside an HTML comment", () => {
  expect(proposedPlanTitle("<!--\n```bash\n# hidden\n-->\n# Real Title")).toBe("Real Title");
  expect(proposedPlanTitle("<!-- ```bash -->\n# Real Title")).toBe("Real Title");
});

it("reads the plan title past a leading byte-order mark", () => {
  for (const markdown of [
    "\uFEFF# Rollout\n\nDeploy",
    "\uFEFF   # Rollout\r\n\r\n## Summary\r\n\r\nDeploy",
  ]) {
    expect(proposedPlanTitle(markdown)).toBe("Rollout");
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Deploy");
  }
  expect(proposedPlanTitle("\uFEFF    # Indented code")).toBeNull();
});
