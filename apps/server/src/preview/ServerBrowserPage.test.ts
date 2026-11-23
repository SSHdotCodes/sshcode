import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { presentAsChrome } from "./ServerBrowserContexts.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("retries a navigation-interrupted snapshot once and returns usable fresh refs", async () => {
    await page.setContent("<button>before navigation</button>");
    const original = page.ariaSnapshot.bind(page);
    const snapshots = vi.spyOn(page, "ariaSnapshot").mockImplementationOnce(async (options) => {
      await page.goto(
        "data:text/html,<button onclick=\"this.textContent='clicked'\">after navigation</button>",
      );
      return original(options);
    });
    const result = await takeSnapshot();
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(result.url).toContain("data:text/html");
    await ServerBrowserPage.click(page, {
      locator: buttonLocator(result.accessibilityTree, "after navigation"),
    });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("bounds navigation snapshot retries and leaves other failures unchanged", async () => {
    const interrupted = new Error(
      "Execution context was destroyed, most likely because of a navigation.",
    );
    const evaluations = vi.spyOn(page, "evaluate").mockRejectedValue(interrupted);
    await expect(takeSnapshot()).rejects.toBe(interrupted);
    expect(evaluations).toHaveBeenCalledTimes(2);
    evaluations.mockClear().mockRejectedValue(new Error("unrelated failure"));
    await expect(takeSnapshot()).rejects.toThrow("unrelated failure");
    expect(evaluations).toHaveBeenCalledTimes(1);
  });

  it("does not retry a snapshot after control changes", async () => {
    const original = page.ariaSnapshot.bind(page);
    const snapshots = vi.spyOn(page, "ariaSnapshot").mockImplementationOnce(async (options) => {
      ServerBrowserPage.invalidateRefs(page);
      return original(options);
    });
    await expect(takeSnapshot()).rejects.toThrow("Browser control changed");
    expect(snapshots).toHaveBeenCalledTimes(1);
  });

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    ServerBrowserPage.invalidateRefs(page);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    const fresh = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await ServerBrowserPage.click(page, { locator: fresh });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("keeps unchanged DOM refs stable across observations", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const first = await takeSnapshot();
    const second = await takeSnapshot();
    expect(second.accessibilityTree).toBe(first.accessibilityTree);
    await ServerBrowserPage.click(page, {
      locator: buttonLocator(first.accessibilityTree, "continue"),
    });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("does not recycle a removed ref across subsequent observations", async () => {
    await page.setContent("<button>original</button>");
    const old = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page
      .locator("button")
      .evaluate((element) => (element.outerHTML = "<button>replacement</button>"));
    const current = buttonLocator((await takeSnapshot()).accessibilityTree, "replacement");
    expect(current).not.toBe(old);
    await expect(ServerBrowserPage.click(page, { locator: old, timeoutMs: 100 })).rejects.toThrow(
      /stale/,
    );
  });

  it("can observe a page without capturing an image", async () => {
    await page.setContent('<h1>Account</h1><input aria-label="Name"><button>Save</button>');
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      captureScreenshot: false,
      compact: true,
    });
    expect(result.screenshot.data).toBe("");
    expect(result.accessibilityTree).toContain('textbox "Name"');
    expect(result.accessibilityTree).toContain('heading "Account"');
  });

  it("reports rejected typing without echoing field values", async () => {
    await page.setContent('<input aria-label="Secret" type="password" oninput="this.value=\'\'">');
    await expect(
      ServerBrowserPage.type(page, { locator: "input", text: "sensitive-value", clear: true }),
    ).rejects.toThrow(/did not retain/);
    await expect(
      ServerBrowserPage.type(page, { locator: "input", text: "sensitive-value", clear: true }),
    ).rejects.not.toThrow(/sensitive-value/);
  });

  it("reports page normalization honestly and leaves the formatted value for inspection", async () => {
    await page.setContent('<input oninput="this.value=this.value.toUpperCase()">');
    await expect(
      ServerBrowserPage.type(page, { locator: "input", text: "ab", clear: true }),
    ).rejects.toThrow(/formatted, changed or rejected/);
    expect(await page.locator("input").inputValue()).toBe("AB");
  });

  it("detects contenteditable handlers replacing inserted text without clear", async () => {
    await page.setContent(
      '<div contenteditable="true" oninput="this.textContent=\'blocked\'">old</div>',
    );
    await expect(
      ServerBrowserPage.type(page, { locator: "[contenteditable]", text: "sensitive-value" }),
    ).rejects.toThrow(/did not retain/);
  });

  it("verifies selection replacement in nested contenteditable text", async () => {
    await page.setContent(
      '<div contenteditable="true"><b>before </b><span>replace</span> after</div>',
    );
    await page.locator("[contenteditable]").evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element.querySelector("span")!);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await ServerBrowserPage.type(page, { locator: "[contenteditable]", text: "new text" });
    expect((await page.locator("[contenteditable]").textContent())?.replace(/\u00a0/g, " ")).toBe(
      "before new text after",
    );
  });

  it("verifies the original focused field when input automatically advances focus", async () => {
    await page.setContent(
      '<input id="first" oninput="document.querySelector(\'#next\').focus()"><input id="next">',
    );
    await page.locator("#first").focus();
    await ServerBrowserPage.type(page, { text: "1" });
    expect(await page.locator("#first").inputValue()).toBe("1");
    expect(await page.locator("#next").inputValue()).toBe("");
  });

  it("retains multiline contenteditable text while replacing and inserting", async () => {
    await page.setContent('<div contenteditable="true">old</div>');
    await ServerBrowserPage.type(page, {
      locator: "[contenteditable]",
      clear: true,
      text: "hello\nworld",
    });
    expect(await page.locator("[contenteditable]").innerText()).toBe("hello\nworld");
    await ServerBrowserPage.type(page, { locator: "[contenteditable]", text: "\nnext" });
    expect(await page.locator("[contenteditable]").innerText()).toBe("hello\nworld\nnext");
  });

  it("does not type into another field when clearing moves focus", async () => {
    await page.setContent(
      '<input id="first" value="old" oninput="document.querySelector(\'#next\').focus()"><input id="next">',
    );
    await page.locator("#first").focus();
    await expect(ServerBrowserPage.type(page, { clear: true, text: "new" })).rejects.toThrow(
      /moved focus/,
    );
    expect(await page.locator("#next").inputValue()).toBe("");
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves CSS selectors containing an aria-ref attribute", async () => {
    await page.setContent(
      '<button aria-ref="save" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[aria-ref="save"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    // A visible label selects the same option as its value.
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });

  it("presents a headless page as Chrome, with client hints that agree", async () => {
    await presentAsChrome(cdp, { platform: "linux", arch: "x64" });
    // userAgentData exists only in secure contexts; https comes from a route.
    let secChUa: string | undefined;
    await page.route("https://example.test/", (route) => {
      secChUa = route.request().headers()["sec-ch-ua"];
      return route.fulfill({ contentType: "text/html", body: "<p>hi</p>" });
    });
    await page.goto("https://example.test/");
    const identity = (await page.evaluate(`(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((brand) => brand.brand),
      full: (await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]))
        .fullVersionList.map((brand) => brand.brand),
    }))()`)) as { userAgent: string; brands: string[]; full: string[] };
    expect(identity.userAgent).not.toContain("Headless");
    expect(identity.userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
    expect(identity.brands).toContain("Google Chrome");
    expect([...identity.brands, ...identity.full].join()).not.toContain("Headless");
    expect(secChUa).toContain('"Google Chrome"');
    expect(secChUa).not.toContain("Headless");
  });

  it("stops an evaluation at its deadline so the page answers the next one", async () => {
    await expect(
      ServerBrowserPage.evaluate(cdp, { expression: "for (;;) {}" }, 200),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(await ServerBrowserPage.evaluate(cdp, { expression: "1 + 1" }, 2_000)).toBe(2);
  });
});

describe("browser error recovery diagnostics", () => {
  it.each([
    ["element is not visible", "hidden"],
    ["element is not enabled", "disabled"],
    ["overlay intercepts pointer events", "covered"],
    ["element was detached", "detached"],
    ["waiting for locator('missing')", "absent"],
  ])("keeps the call-log reason %s", (log, reason) => {
    const cause = new Error(`locator.click: Timeout 1000ms exceeded.\nCall log:\n - ${log}`);
    cause.name = "TimeoutError";
    expect(ServerBrowserPage.toOperationError(cause)).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { reason },
    });
  });

  it("classifies a removed native ref and bounds unclassified errors", () => {
    expect(
      ServerBrowserPage.toOperationError(new Error("No element found for aria-ref=e12")),
    ).toMatchObject({ tag: "PreviewAutomationInvalidSelectorError", detail: { staleRef: true } });
    expect(
      ServerBrowserPage.toOperationError(new Error("x".repeat(10_000))).message.length,
    ).toBeLessThanOrEqual(500);
    expect(
      ServerBrowserPage.toOperationError(new Error("Unexpected token while parsing selector")),
    ).toMatchObject({ tag: "PreviewAutomationInvalidSelectorError" });
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    // Only the calls `drag` makes. The drag fails at once; the target's position arrives only
    // when the test hands it over, after the rejection has had a turn to go unobserved.
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      // The failed drag waits for the cursor to reach the target before it reports.
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
