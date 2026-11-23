/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node benchmark driving Chrome.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

// Run against an isolated production server with a synthetic stopped chat.
// Usage: node scripts/performance/browser-startup.ts <origin> <thread-path> <storage-state> <output-prefix> [local|remote]
const [origin, threadPath, storageStatePath, outputPrefix, network = "local"] =
  process.argv.slice(2);
if (!origin || !threadPath || !storageStatePath || !outputPrefix) {
  throw new Error("Expected origin, thread path, browser storage-state path, and output prefix");
}
if (network !== "local" && network !== "remote")
  throw new Error("Expected local or remote network");
const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { default: playwright } = await import(require.resolve("playwright-core"));
const { chromium } = playwright;
const state = JSON.parse(NodeFS.readFileSync(storageStatePath, "utf8"));
const runs = [];
for (let sample = 0; sample < 5; sample += 1) {
  const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sshcode-startup-browser-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await context.addCookies(state.cookies);
    await context.route(
      "**/*",
      (route: {
        request(): { url(): string };
        continue(): Promise<void>;
        abort(): Promise<void>;
      }) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()),
    );
    await context.addInitScript(() => {
      localStorage.setItem(
        "t3code:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-26T00:00:00.000Z" }),
      );
      localStorage.setItem("t3code:theme", "dark");
      const result = { chatMs: 0, shifts: 0, longTasks: [] as number[] };
      Object.assign(window, { __startupBenchmark: result });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!result.chatMs) result.longTasks.push(entry.duration);
        }
      }).observe({ type: "longtask", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<
          PerformanceEntry & { hadRecentInput: boolean; value: number }
        >) {
          if (!entry.hadRecentInput && !result.chatMs) result.shifts += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      const visible = (element: Element) => {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight)
          return false;
        const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return top !== null && (element.contains(top) || top.contains(element));
      };
      const check = () => {
        const composer = document.querySelector('[contenteditable="true"]');
        const reply = [...document.querySelectorAll("p")].find(
          (element) =>
            element.textContent?.includes("Startup benchmark message.") && visible(element),
        );
        if (composer && visible(composer) && reply) {
          requestAnimationFrame(() => {
            result.chatMs = performance.now();
          });
        } else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    const page = context.pages()[0]!;
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (network === "remote") {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 20,
        downloadThroughput: 1_250_000,
        uploadThroughput: 625_000,
        connectionType: "wifi",
      });
    }
    await page.goto(`${origin}${threadPath}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        (window as unknown as { __startupBenchmark: { chatMs: number } }).__startupBenchmark
          .chatMs > 0,
      undefined,
      { timeout: 30_000 },
    );
    const result = await page.evaluate(() => {
      const measured = (
        window as unknown as {
          __startupBenchmark: { chatMs: number; shifts: number; longTasks: number[] };
        }
      ).__startupBenchmark;
      const scripts = (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).filter(
        (entry) =>
          entry.name.includes("/assets/") &&
          new URL(entry.name).pathname.endsWith(".js") &&
          entry.responseEnd <= measured.chatMs,
      );
      return {
        ...measured,
        fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
        scriptBytes: scripts.reduce((total, entry) => total + entry.decodedBodySize, 0),
        scriptTransferBytes: scripts.reduce((total, entry) => total + entry.encodedBodySize, 0),
        scripts: scripts.map((entry) => new URL(entry.name).pathname),
      };
    });
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join("; ")}`);
    runs.push(result);
    if (sample === 2) await page.screenshot({ path: `${outputPrefix}.png` });
    console.log(
      JSON.stringify({
        sample,
        chatMs: result.chatMs,
        scriptBytes: result.scriptBytes,
        scriptTransferBytes: result.scriptTransferBytes,
        shifts: result.shifts,
      }),
    );
  } finally {
    await context.close();
    NodeFS.rmSync(profile, { recursive: true, force: true });
  }
}
const sorted = runs.map((run) => run.chatMs).sort((left, right) => left - right);
const report = {
  network,
  medianChatMs: sorted[2],
  minChatMs: sorted[0],
  maxChatMs: sorted[4],
  runs,
};
NodeFS.writeFileSync(`${outputPrefix}.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    medianChatMs: report.medianChatMs,
    minChatMs: report.minChatMs,
    maxChatMs: report.maxChatMs,
  }),
);
