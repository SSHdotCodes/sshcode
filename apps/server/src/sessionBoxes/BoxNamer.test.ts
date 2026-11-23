import { describe, expect, it } from "vite-plus/test";

import { boxNamerPrompt, parseBoxNamerOutput } from "./BoxNamer.ts";
import {
  AUTO_TITLE_WORK_MS,
  autoTitleFor,
  boxNamerCache,
  boxTitles,
  lookupBoxNaming,
  subscribeBoxNamed,
  subscribeRetitle,
  type RetitleCandidate,
} from "./boxNamerCache.ts";

describe("boxNamerPrompt", () => {
  it("writes the box-v1 prompt the model was trained on", () => {
    expect(
      boxNamerPrompt({
        title: "[Streamline SSHCode](t3-context://x)   Harness",
        asks: ["first", "second\nline", "third", "fourth"],
        reply: "Done.\nAll good",
      }),
    ).toBe(
      [
        "<title>",
        "Streamline SSHCode Harness",
        "<asks>",
        "- second line",
        "- third",
        "- fourth",
        "<reply>",
        "Done. All good",
        "<box>",
        "",
      ].join("\n"),
    );
    expect(boxNamerPrompt({ title: "Chat", asks: [], reply: null })).toBe(
      "<title>\nChat\n<asks>\n-\n<reply>\n-\n<box>\n",
    );
  });
});

describe("parseBoxNamerOutput", () => {
  it("reads each line and treats a dash, a blank or an overlong line as none", () => {
    expect(parseBoxNamerOutput("Name: SSHCode Harness\nNow: Box names\n")).toEqual({
      name: "SSHCode Harness",
      now: "Box names",
      retitle: null,
    });
    expect(parseBoxNamerOutput("Name: Studio UI\nNow: -")).toEqual({
      name: "Studio UI",
      now: null,
      retitle: null,
    });
    expect(parseBoxNamerOutput(`Name: ${"x".repeat(41)}\nNow:`)).toEqual({
      name: null,
      now: null,
      retitle: null,
    });
    expect(
      parseBoxNamerOutput(
        "Name: Sideload Kettu\nNow: YouTube client\nTitle: Sideload a YouTube Client",
      ),
    ).toEqual({
      name: "Sideload Kettu",
      now: "YouTube client",
      retitle: "Sideload a YouTube Client",
    });
  });
});

describe("boxNamerCache", () => {
  it("asks for fresh names when the request or title changes and keeps the name meanwhile", () => {
    const named: string[] = [];
    const unsubscribe = subscribeBoxNamed((threadId) => named.push(threadId));
    let wakes = 0;
    boxNamerCache.activate([], () => wakes++);
    const basis = { title: "Studio UI", requestId: "m1" };
    expect(lookupBoxNaming("t1", basis)).toBeNull();
    expect(wakes).toBe(1);
    expect(boxNamerCache.take()).toEqual(["t1", basis]);
    boxNamerCache.put("t1", { ...basis, name: "Studio UI", now: "Phone pairing" });
    expect(named).toEqual(["t1"]);
    expect(lookupBoxNaming("t1", basis)).toEqual({ name: "Studio UI", now: "Phone pairing" });
    expect(boxNamerCache.take()).toBeUndefined();
    // A new request keeps the name but not the stale "now" line until the model reads it.
    expect(lookupBoxNaming("t1", { ...basis, requestId: "m2" })).toEqual({
      name: "Studio UI",
      now: undefined,
    });
    expect(boxNamerCache.take()?.[1].requestId).toBe("m2");
    unsubscribe();
    boxNamerCache.deactivate();
    expect(lookupBoxNaming("t1", basis)).toBeNull();
  });
});

describe("retitles", () => {
  const thread = {
    title: "Streamline the harness",
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null },
  };
  const entry = (requestId: string, retitle: string | null) => ({
    title: thread.title,
    requestId,
    name: null,
    now: retitle,
    retitle,
  });

  it("never offers a rename from the now line alone (box-v1 models)", () => {
    const offered: RetitleCandidate[] = [];
    const unsubscribe = subscribeRetitle((candidate) => offered.push(candidate));
    boxNamerCache.put("r0", {
      title: thread.title,
      requestId: "m1",
      name: null,
      now: "Quality loss notice",
    });
    boxNamerCache.put("r0", {
      title: thread.title,
      requestId: "m2",
      name: null,
      now: "Quality loss notice",
      retitle: null,
    });
    unsubscribe();
    expect(offered).toEqual([]);
  });

  it("offers a chat once its work moves on, settled when the next request agrees", () => {
    const offered: RetitleCandidate[] = [];
    const unsubscribe = subscribeRetitle((candidate) => offered.push(candidate));
    boxNamerCache.put("r1", entry("m1", null));
    boxNamerCache.put("r1", entry("m2", "Studio phone pairing"));
    boxNamerCache.put("r1", entry("m3", "Pairing Studio with the iPhone"));
    unsubscribe();
    expect(offered.map((candidate) => [candidate.requestId, candidate.settled])).toEqual([
      ["m2", false],
      ["m3", true],
    ]);
    expect(autoTitleFor({ candidate: offered[1]!, thread, latestRun: null, nowMs: 0 })).toBe(
      "Pairing Studio with the iPhone",
    );
    // One rename per request.
    boxTitles.retitled("m3");
    expect(autoTitleFor({ candidate: offered[1]!, thread, latestRun: null, nowMs: 0 })).toBeNull();
    // A title that changed since the model read it is left alone.
    expect(
      autoTitleFor({
        candidate: offered[1]!,
        thread: { ...thread, title: "Renamed" },
        latestRun: null,
        nowMs: 0,
      }),
    ).toBeNull();
  });

  it("retitles on a single request only after the agent has worked on it a while", () => {
    const offered: RetitleCandidate[] = [];
    const unsubscribe = subscribeRetitle((candidate) => offered.push(candidate));
    boxNamerCache.put("r2", entry("m1", "Dynamic session titles"));
    unsubscribe();
    const candidate = offered[0]!;
    const run = (minutes: number) => ({ startedAtMs: 0, endedAtMs: minutes * 60_000 });
    expect(autoTitleFor({ candidate, thread, latestRun: run(1), nowMs: 0 })).toBeNull();
    expect(
      autoTitleFor({
        candidate,
        thread,
        latestRun: { startedAtMs: 0, endedAtMs: null },
        nowMs: AUTO_TITLE_WORK_MS,
      }),
    ).toBe("Dynamic session titles");
    // A newer request supersedes it.
    boxNamerCache.put("r2", entry("m2", null));
    expect(autoTitleFor({ candidate, thread, latestRun: run(10), nowMs: 0 })).toBeNull();
  });

  it("never offers or retitles a chat the user named, until they regenerate", () => {
    const offered: RetitleCandidate[] = [];
    const unsubscribe = subscribeRetitle((candidate) => offered.push(candidate));
    boxTitles.markByHand("r3");
    boxNamerCache.put("r3", entry("m1", "Studio phone pairing"));
    expect(offered).toEqual([]);
    boxTitles.clearByHand("r3");
    boxNamerCache.put("r3", entry("m2", "Studio phone pairing"));
    unsubscribe();
    expect(offered.map((candidate) => candidate.requestId)).toEqual(["m2"]);
    expect(
      autoTitleFor({
        candidate: offered[0]!,
        thread: { ...thread, lineage: { relationshipToParent: "subagent" } },
        latestRun: null,
        nowMs: 0,
      }),
    ).toBeNull();
  });
});
