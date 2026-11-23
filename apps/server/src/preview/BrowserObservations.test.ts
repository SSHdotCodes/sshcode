import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { PreviewTabId, type PreviewAutomationSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as BrowserObservations from "./BrowserObservations.ts";
import { chromium } from "playwright-core";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const snapshot = (tree: string, tabId = "tab-a"): PreviewAutomationSnapshot => ({
  tabId: PreviewTabId.make(tabId),
  url: "https://example.test/account",
  title: "Account",
  loading: false,
  visibleText: "Account",
  interactiveElements: [],
  accessibilityTree: tree,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: "", width: 1280, height: 800 },
});
const tree = Array.from(
  { length: 60 },
  (_, i) => `- button "Account ${i}" [ref=t3-page-e${i}]`,
).join("\n");

it.effect("keeps real quoted control refs usable and preserves unique ARIA row labels", () =>
  Effect.gen(function* () {
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ headless: true })),
      (browser) => Effect.promise(() => browser.close()),
    );
    const page = yield* Effect.promise(() => browser.newPage());
    const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
    yield* Effect.promise(() =>
      page.setContent(
        '<button onclick="this.dataset.clicked=1">Save: now</button><input aria-label="Email: work"><input type="checkbox" aria-label="I agree: terms"><div role="grid"><div role="row" aria-label="Overdue invoice 1042"><button>Pay</button></div><div role="row" aria-label="Overdue invoice 2048"><button>Pay</button></div></div>',
      ),
    );
    const snapshot = yield* Effect.promise(() =>
      ServerBrowserPage.snapshot({
        page,
        cdp,
        renderScale: 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        captureScreenshot: false,
        compact: true,
      }),
    );
    const observations = yield* BrowserObservations.BrowserObservations;
    const compact = yield* observations.observe("real-browser-test", snapshot, {});
    const refFor = (role: string, name: string) => {
      const line = compact.tree!.split("\n").find((line) => line.includes(`${role} "${name}"`));
      const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
      expect(ref).toBeDefined();
      return `aria-ref=${ref}`;
    };
    yield* Effect.promise(() =>
      ServerBrowserPage.click(page, { locator: refFor("button", "Save: now") }),
    );
    yield* Effect.promise(() =>
      ServerBrowserPage.type(page, {
        locator: refFor("textbox", "Email: work"),
        text: "test@example.test",
        clear: true,
      }),
    );
    yield* Effect.promise(() =>
      ServerBrowserPage.click(page, { locator: refFor("checkbox", "I agree: terms") }),
    );
    expect(
      yield* Effect.promise(() =>
        page.getByRole("button", { name: "Save: now" }).getAttribute("data-clicked"),
      ),
    ).toBe("1");
    expect(yield* Effect.promise(() => page.getByRole("textbox").inputValue())).toBe(
      "test@example.test",
    );
    expect(yield* Effect.promise(() => page.getByRole("checkbox").isChecked())).toBe(true);
    expect(compact.tree).toContain("Overdue invoice 1042");
    expect(compact.tree).toContain("Overdue invoice 2048");
  }).pipe(
    Effect.scoped,
    Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer))),
  ),
);

it.effect("compacts long pages before applying the character budget", () =>
  Effect.gen(function* () {
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ headless: true })),
      (browser) => Effect.promise(() => browser.close()),
    );
    const page = yield* Effect.promise(() => browser.newPage());
    const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
    const items = Array.from(
      { length: 60 },
      (_, i) =>
        `<tr><td>${i + 1}.</td><td><span><a href="/item/${i}">Story ${i + 1} title</a> <span>(<a href="/from/${i}">example.com</a>)</span></span></td></tr>`,
    ).join("");
    yield* Effect.promise(() => page.setContent(`<table>${items}</table>`));
    const snapshot = yield* Effect.promise(() =>
      ServerBrowserPage.snapshot({
        page,
        cdp,
        renderScale: 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        captureScreenshot: false,
        compact: true,
      }),
    );
    // The raw tree alone is over the budget; compacted, the whole list fits.
    expect(String(snapshot.accessibilityTree).length).toBeGreaterThan(20_000);
    const observations = yield* BrowserObservations.BrowserObservations;
    const compact = yield* observations.observe("long-page-test", snapshot, {
      maxChars: 20_000,
    });
    expect(compact.tree).toContain('link "Story 60 title"');
    expect(compact.omitted).toBeUndefined();
  }).pipe(
    Effect.scoped,
    Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer))),
  ),
);

it.effect("drops repeated names and layout wrappers without moving content", () =>
  Effect.gen(function* () {
    // Shaped like Hacker News: computed row and cell names repeat their content,
    // and the domain link sits in a wrapper beside the title link, not inside it.
    const raw = [
      "- generic [active] [ref=t3-page-e1]:",
      "  - table [ref=t3-page-e2]:",
      '    - row "1. upvote Story title (example.com)" [ref=t3-page-e3]:',
      '      - cell "1." [ref=t3-page-e4]',
      '      - cell "upvote" [ref=t3-page-e5]:',
      '        - link "upvote" [ref=t3-page-e6] [cursor=pointer]:',
      "          - /url: vote?id=1",
      '          - generic "upvote" [ref=t3-page-e7]',
      '      - cell "Story title (example.com)" [ref=t3-page-e8]:',
      "        - generic [ref=t3-page-e9]:",
      '          - link "Story title" [ref=t3-page-e10] [cursor=pointer]:',
      "            - /url: https://example.com/story",
      "          - generic [ref=t3-page-e11]:",
      "            - text: (",
      '            - link "example.com" [ref=t3-page-e12] [cursor=pointer]:',
      "              - /url: from?site=example.com",
      "            - text: )",
      "    - row [ref=t3-page-e13]",
      `    - 'row "Invoice: 1042" [ref=t3-page-e14]':`,
      '      - cell "Pay" [ref=t3-page-e15]:',
      '        - button "Pay" [ref=t3-page-e16]',
      '  - generic "Opens menu" [ref=t3-page-e17] [cursor=pointer]',
    ].join("\n");
    const observations = yield* BrowserObservations.BrowserObservations;
    const compact = yield* observations.observe("agent-a", snapshot(raw), {});
    expect(compact.tree).toBe(
      [
        "- table:",
        "  - row:",
        '    - cell "1."',
        '    - link "upvote" [ref=t3-page-e6]',
        "    - cell:",
        '      - link "Story title" [ref=t3-page-e10]:',
        "        - /url: https://example.com/story",
        '      - link "example.com" [ref=t3-page-e12]',
        `  - 'row "Invoice: 1042"':`,
        '    - button "Pay" [ref=t3-page-e16]',
        '- generic "Opens menu" [ref=t3-page-e17] [cursor=pointer]',
      ].join("\n"),
    );
    const full = yield* observations.observe("agent-a", snapshot(raw), { mode: "full" });
    expect(full.tree).toBe(raw);
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("keeps a control's own label only once and a heading's text always", () =>
  Effect.gen(function* () {
    const raw = [
      '- heading "Pricing" [level=2] [ref=t3-page-e1]:',
      "  - text: Pricing",
      '- link "Wikipedia The Free Encyclopedia" [ref=t3-page-e2] [cursor=pointer]:',
      "  - /url: /wiki/Main_Page",
      '  - img "Wikipedia"',
      '  - img "The Free Encyclopedia"',
      '- button "Hide contents" [ref=t3-page-e3]:',
      "  - generic: Hide contents",
    ].join("\n");
    const observations = yield* BrowserObservations.BrowserObservations;
    const compact = yield* observations.observe("agent-a", snapshot(raw), {});
    expect(compact.tree).toBe(
      [
        "- heading [level=2]:",
        "  - text: Pricing",
        '- link "Wikipedia The Free Encyclopedia" [ref=t3-page-e2]',
        '- button "Hide contents" [ref=t3-page-e3]',
      ].join("\n"),
    );
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("keeps off-site links and drops same-site paths and repeated link fragments", () =>
  Effect.gen(function* () {
    // Shaped like a GitHub file row: a commit link split around its PR link.
    const raw = [
      "- cell [ref=t3-page-e1]:",
      '  - link "fix thing (" [ref=t3-page-e2] [cursor=pointer]:',
      "    - /url: /org/repo/commit/abc",
      '  - link "#12" [ref=t3-page-e3] [cursor=pointer]:',
      "    - /url: https://github.com/org/repo/pull/12",
      '  - link ")" [ref=t3-page-e4] [cursor=pointer]:',
      "    - /url: /org/repo/commit/abc",
      '  - link "Docs" [ref=t3-page-e5] [cursor=pointer]:',
      "    - /url: https://docs.example.com/start",
      '  - link "Mail us" [ref=t3-page-e6]:',
      "    - /url: mailto:hi@example.com",
    ].join("\n");
    const observations = yield* BrowserObservations.BrowserObservations;
    const compact = yield* observations.observe(
      "agent-a",
      { ...snapshot(raw), url: "https://www.github.com/org/repo" },
      {},
    );
    expect(compact.tree).toBe(
      [
        "- cell:",
        '  - link "fix thing (" [ref=t3-page-e2]',
        '  - link "#12" [ref=t3-page-e3]',
        '  - link "Docs" [ref=t3-page-e5]:',
        "    - /url: https://docs.example.com/start",
        '  - link "Mail us" [ref=t3-page-e6]:',
        "    - /url: mailto:hi@example.com",
      ].join("\n"),
    );
    const full = yield* observations.observe(
      "agent-a",
      { ...snapshot(raw), url: "https://www.github.com/org/repo" },
      { mode: "full" },
    );
    expect(full.tree).toContain("/url: /org/repo/commit/abc");
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("keeps controls and their context in interactive mode", () =>
  Effect.gen(function* () {
    const raw = [
      "- banner [ref=t3-page-e1]:",
      '  - link "Home" [ref=t3-page-e2] [cursor=pointer]:',
      "    - /url: /",
      '- heading "Invoices" [level=1] [ref=t3-page-e3]',
      "- paragraph [ref=t3-page-e4]: Three invoices are overdue this month.",
      '- row "Overdue invoice 1042" [ref=t3-page-e5]:',
      '  - cell "Overdue invoice 1042" [ref=t3-page-e6]',
      '  - button "Pay" [ref=t3-page-e7]',
      "- list [ref=t3-page-e8]:",
      "  - listitem [ref=t3-page-e9]: Paid invoices are archived after a year.",
      '- status "Saved" [ref=t3-page-e10]',
    ].join("\n");
    const observations = yield* BrowserObservations.BrowserObservations;
    const interactive = yield* observations.observe("agent-a", snapshot(raw), {
      mode: "interactive",
    });
    expect(interactive.mode).toBe("interactive");
    expect(interactive.tree).toBe(
      [
        "- banner:",
        '  - link "Home" [ref=t3-page-e2]',
        '- heading "Invoices" [level=1]',
        "- row:",
        '  - cell "Overdue invoice 1042"',
        '  - button "Pay" [ref=t3-page-e7]',
        '- status "Saved"',
      ].join("\n"),
    );
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("returns compact trees and exact, smaller patches against explicit baselines", () =>
  Effect.gen(function* () {
    const observations = yield* BrowserObservations.BrowserObservations;
    const first = yield* observations.observe("agent-a", snapshot(tree), {});
    expect(first.tree).toBe(tree);
    const nextTree = tree.replace("Account 20", "Saved account 20");
    const next = yield* observations.observe("agent-a", snapshot(nextTree), {
      since: first.snapshotId,
    });
    expect(next.baseSnapshotId).toBe(first.snapshotId);
    expect(next.changes).toBeDefined();
    const lines = first.tree!.split("\n");
    for (const change of next.changes!.toReversed())
      lines.splice(change.fromLine, change.deleteCount, ...change.lines);
    expect(lines.join("\n")).toBe(nextTree);
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(first)) / 4,
    );
    const unchanged = yield* observations.observe("agent-a", snapshot(nextTree), {
      since: next.snapshotId,
    });
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.tree).toBeUndefined();
    expect(unchanged.changes).toBeUndefined();
    const retry = yield* observations.observe("agent-a", snapshot(nextTree), {
      since: first.snapshotId,
    });
    expect(retry.changes).toEqual(next.changes);
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("keeps sparse edits small when early text changes shift the bounded tail", () =>
  Effect.gen(function* () {
    const observations = yield* BrowserObservations.BrowserObservations;
    const first = yield* observations.observe("agent-a", snapshot(tree), { maxChars: 2000 });
    const raw = tree.replace('Account 1"', `Account ${"expanded name ".repeat(12)}"`);
    const next = yield* observations.observe("agent-a", snapshot(raw), {
      maxChars: 2000,
      since: first.snapshotId,
    });
    const full = yield* observations.observe("agent-a", snapshot(raw), { maxChars: 2000 });
    expect(next.changes?.length).toBeGreaterThan(1);
    const lines = first.tree!.split("\n");
    for (const change of next.changes!.toReversed())
      lines.splice(change.fromLine, change.deleteCount, ...change.lines);
    expect(lines.join("\n")).toBe(full.tree);
    expect(JSON.stringify(next).length).toBeLessThan(JSON.stringify(full).length / 2);
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("reconstructs inserts, deletions, repeated lines, rewrites and empty pages exactly", () =>
  Effect.gen(function* () {
    const observations = yield* BrowserObservations.BrowserObservations;
    const original = tree.split("\n");
    const variants = [
      [...original.slice(0, 15), '- button "New" [ref=t3-page-new]', ...original.slice(15)].join(
        "\n",
      ),
      [...original.slice(0, 10), ...original.slice(20)].join("\n"),
      tree.replace('Account 1"', 'Changed one"').replace('Account 58"', 'Changed fifty-eight"'),
      [...original.slice(0, 15), ...original.slice(0, 10), ...original.slice(15)].join("\n"),
      '- heading "Completely new page"',
      "",
    ];
    for (const variant of variants) {
      const first = yield* observations.observe("agent-a", snapshot(tree), {});
      const next = yield* observations.observe("agent-a", snapshot(variant), {
        since: first.snapshotId,
      });
      const full = yield* observations.observe("agent-a", snapshot(variant), {});
      const lines = first.tree!.split("\n");
      if (next.changes)
        for (const change of next.changes.toReversed())
          lines.splice(change.fromLine, change.deleteCount, ...change.lines);
      expect(next.tree ?? lines.join("\n")).toBe(full.tree);
    }
    const first = yield* observations.observe("agent-a", snapshot(tree), {});
    const renamed = yield* observations.observe(
      "agent-a",
      { ...snapshot(tree), title: "Updated title", loading: true },
      { since: first.snapshotId },
    );
    expect(renamed.title).toBe("Updated title");
    expect(renamed.loading).toBe(true);
    expect(renamed.unchanged).toBeUndefined();
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect(
  "never shares diff baselines between authenticated sessions, tabs, or observation options",
  () =>
    Effect.gen(function* () {
      const observations = yield* BrowserObservations.BrowserObservations;
      const first = yield* observations.observe("agent-a", snapshot(tree), {});
      for (const [namespace, page, options] of [
        ["agent-b", snapshot(tree), {}],
        ["agent-a", snapshot(tree, "tab-b"), {}],
        ["agent-a", snapshot(tree), { mode: "full" as const }],
        ["agent-a", snapshot(tree), { maxChars: 2000 }],
      ] as const) {
        const next = yield* observations.observe(namespace, page, {
          ...options,
          since: first.snapshotId,
        });
        expect(next.tree).toBeDefined();
        expect(next.unchanged).toBeUndefined();
        expect(next.changes).toBeUndefined();
      }
    }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("expires baselines and safely falls back after eviction or an unknown ID", () =>
  Effect.gen(function* () {
    const observations = yield* BrowserObservations.BrowserObservations;
    const first = yield* observations.observe("agent-a", snapshot(tree), {});
    yield* TestClock.adjust("16 minutes");
    expect(
      (yield* observations.observe("agent-a", snapshot(tree), { since: first.snapshotId })).tree,
    ).toBe(tree);
    for (let i = 0; i < 130; i++)
      yield* observations.observe("agent-a", snapshot(`${tree}\n- text: ${i}`), {});
    expect(
      (yield* observations.observe("agent-a", snapshot(tree), { since: first.snapshotId })).tree,
    ).toBe(tree);
    expect(
      (yield* observations.observe("agent-a", snapshot(tree), { since: "unknown" })).tree,
    ).toBe(tree);
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect(
  "preserves semantic context, states, controls and frames while removing layout noise",
  () =>
    Effect.gen(function* () {
      const observations = yield* BrowserObservations.BrowserObservations;
      const raw =
        '- generic [ref=t3-p-e1]:\n  - heading "Invoice" [level=1]\n  - paragraph: Amount due $123\n  - status: Payment failed\n  - button "Pay" [disabled] [ref=t3-p-e2] [box=1,2,3,4]\n  - iframe:\n    - textbox "Card" [ref=t3-p-f1e1]';
      const compact = yield* observations.observe("agent-a", snapshot(raw), {});
      expect(compact.tree).not.toContain("generic");
      expect(compact.tree).not.toContain("[box=");
      for (const meaning of [
        "Invoice",
        "$123",
        "Payment failed",
        "[disabled]",
        "t3-p-e2",
        "t3-p-f1e1",
      ])
        expect(compact.tree).toContain(meaning);
      expect((yield* observations.observe("agent-a", snapshot(raw), { mode: "full" })).tree).toBe(
        raw,
      );
    }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect(
  "keeps table values and column order once, with refs for controls and full-mode fallback",
  () =>
    Effect.gen(function* () {
      const observations = yield* BrowserObservations.BrowserObservations;
      const raw =
        '- table [ref=t3-p-e1]:\n  - row "Plan Price Choose" [ref=t3-p-e2]:\n    - columnheader "Plan" [ref=t3-p-e3]\n    - columnheader "Price" [ref=t3-p-e4]\n    - columnheader "Choose" [ref=t3-p-e5]\n  - row "Pro $123 Buy" [ref=t3-p-e6]:\n    - cell "Pro" [ref=t3-p-e7]\n    - cell "$123" [ref=t3-p-e8]\n    - button "Buy" [ref=t3-p-e9]';
      const compact = yield* observations.observe("agent-a", snapshot(raw), {});
      expect(compact.tree?.match(/\$123/g)).toHaveLength(1);
      expect(compact.tree).toContain('columnheader "Price"');
      expect(compact.tree).toContain('button "Buy" [ref=t3-p-e9]');
      expect(compact.tree).not.toContain("t3-p-e8");
      const full = yield* observations.observe("agent-a", snapshot(raw), { mode: "full" });
      expect(full.tree).toBe(raw);
    }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect(
  "bounds unicode and hostile metadata, reports omissions, and excludes logs unless requested",
  () =>
    Effect.gen(function* () {
      const observations = yield* BrowserObservations.BrowserObservations;
      const page = {
        ...snapshot(`${tree}\n${"界".repeat(30_000)}`),
        title: "\u0000".repeat(100_000),
        url: "\u0000".repeat(100_000),
        consoleEntries: Array.from({ length: 100 }, () => ({
          level: "界".repeat(100_000),
          text: "界".repeat(100_000),
          timestamp: "t",
        })),
      };
      const normal = yield* observations.observe("agent-a", page, {});
      expect(normal.diagnostics).toBeUndefined();
      const detailed = yield* observations.observe("agent-a", page, {
        includeDiagnostics: true,
        maxChars: 20_000,
      });
      for (const result of [normal, detailed]) {
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(20_000);
        expect(result.tree).toContain("t3-page-e0");
        expect(result.omitted?.length).toBeGreaterThan(0);
        expect(result).not.toHaveProperty("screenshot");
        expect(result).not.toHaveProperty("visibleText");
      }
      expect(detailed.diagnostics?.console.length).toBeLessThanOrEqual(8);
    }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("reports an action's page change against the caller's latest snapshot", () =>
  Effect.gen(function* () {
    const observations = yield* BrowserObservations.BrowserObservations;
    // Nothing to diff against until the caller has looked at the tab.
    expect(yield* observations.observeActionChange("agent-a", snapshot(tree))).toBeUndefined();

    const first = yield* observations.observe("agent-a", snapshot(tree), { mode: "interactive" });
    const clicked = tree.replace('"Account 3"', '"Account 3 (saved)"');
    const change = yield* observations.observeActionChange("agent-a", snapshot(clicked));
    expect(change).toMatchObject({
      baseSnapshotId: first.snapshotId,
      changes: [
        { fromLine: 3, deleteCount: 1, lines: ['- button "Account 3 (saved)" [ref=t3-page-e3]'] },
      ],
    });
    // Another caller or tab has its own baseline.
    expect(yield* observations.observeActionChange("agent-b", snapshot(clicked))).toBeUndefined();
    expect(
      yield* observations.observeActionChange("agent-a", snapshot(clicked, "tab-b")),
    ).toBeUndefined();

    // The next action diffs against the change the caller just saw.
    const again = yield* observations.observeActionChange("agent-a", snapshot(clicked));
    expect(again).toMatchObject({ baseSnapshotId: change!.snapshotId, unchanged: true });

    // A rewritten page is left for a snapshot, and the baseline stays the one the caller saw.
    const rewritten = Array.from(
      { length: 200 },
      (_, i) => `- link "Result number ${i} with a long title" [ref=t3-page-r${i}]`,
    ).join("\n");
    const large = yield* observations.observeActionChange("agent-a", snapshot(rewritten));
    expect(large).toEqual({
      url: "https://example.test/account",
      title: "Account",
      loading: false,
      note: "The page changed a lot; take a snapshot to see it.",
    });
    const after = yield* observations.observeActionChange("agent-a", snapshot(clicked));
    expect(after).toMatchObject({ baseSnapshotId: again!.snapshotId, unchanged: true });
  }).pipe(Effect.provide(BrowserObservations.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);
