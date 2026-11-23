import { describe, expect, it } from "vite-plus/test";
import { filterCommandPaletteGroups, type CommandPaletteActionItem } from "./CommandPalette.logic";

// Synthetic titles and metadata keep this reproducible without loading chat history.
const items: CommandPaletteActionItem[] = Array.from({ length: 10_000 }, (_, index) => ({
  kind: "action",
  value: `thread:${index}`,
  title: `Improve ${["keyboard navigation", "project search", "settings layout", "terminal focus"][index % 4]} ${index}`,
  searchTerms: [
    `Improve ${["keyboard navigation", "project search", "settings layout", "terminal focus"][index % 4]} ${index}`,
    "SSHCode",
    `feature/iteration-${index}`,
    `thread-${index}`,
  ],
  searchRecency: index,
  icon: null,
  run: async () => {},
}));

function search(query: string) {
  return filterCommandPaletteGroups({
    activeGroups: [],
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: items,
  });
}

describe("command palette with 10,000 chats", () => {
  it("finds abbreviated titles throughout the full chat list", () => {
    const start = performance.now();
    const results = search("kbnav")[0]?.items ?? [];
    console.info("10,000 chat fuzzy search (ms)", (performance.now() - start).toFixed(2));
    expect(results).toHaveLength(100);
    expect(results[0]?.value).toBe("thread:9996");
    expect(search("kbnav")[0]?.label).toBe("Chats · 100 of 2500 matches");
  });

  it("still finds an old chat outside the first hundred matches by title or ID", () => {
    expect(search("Improve keyboard navigation 0")[0]?.items[0]?.value).toBe("thread:0");
    expect(search("thread-0")[0]?.items.map((item) => item.value)).toEqual(["thread:0"]);
  });
  it("keeps results recent-first and measures repeated searches", () => {
    const queries = ["key", "keyboard", "keyboard navigation", "project", "settings", "missing"];
    for (const query of queries) search(query);
    const timings: number[] = [];
    for (let iteration = 0; iteration < 30; iteration += 1) {
      for (const query of queries) {
        const start = performance.now();
        search(query);
        timings.push(performance.now() - start);
      }
    }
    timings.sort((left, right) => left - right);
    console.info("10,000 chat searches (ms)", {
      median: timings[Math.floor(timings.length / 2)]?.toFixed(2),
      p95: timings[Math.floor(timings.length * 0.95)]?.toFixed(2),
    });
    const result = search("keyboard")[0]?.items ?? [];
    expect(result).toHaveLength(100);
    expect(result[0]?.value).toBe("thread:9996");
    expect(result.at(-1)?.value).toBe("thread:9600");
  });
});
