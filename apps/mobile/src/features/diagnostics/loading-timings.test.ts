import { describe, expect, it } from "vite-plus/test";
import { loadingTimingLines } from "./loading-timings";

describe("loading timings", () => {
  it("shows the latest launch and skips malformed records", () => {
    const lines = [
      { name: "app.launch", atMs: 300 },
      { name: "home.list.visible", atMs: 500 },
      { name: "app.launch", atMs: 200 },
      { name: "shell.preview", atMs: 250 },
      { name: "home.list.visible", atMs: 270 },
      { name: "chat.opened", atMs: 500 },
      { name: "chat.messages.ready", atMs: 530 },
    ].map((value) => JSON.stringify(value));
    lines.splice(4, 0, "broken", "null", '{"name":"shell.live","atMs":"bad"}');
    expect(loadingTimingLines(lines.join("\n"))).toEqual([
      "App registered: 0 ms",
      "First-screen cache ready: 50 ms",
      "Chat list visible: 70 ms",
      "Chat opened: 300 ms",
      "Chat messages ready: 330 ms, open +30 ms",
    ]);
  });
  it("uses launch-relative time even when the native performance clock contains device uptime", () => {
    const marks = [
      { name: "home.list.visible", atMs: 568460000 },
      { name: "app.launch", atMs: 568465872 },
      { name: "home.list.visible", atMs: 568466696 },
      { name: "connect.probe.finished", atMs: 568467000 },
      { name: "thread.http", atMs: 568467100 },
    ];
    expect(loadingTimingLines(marks.map((mark) => JSON.stringify(mark)).join("\n"))).toEqual([
      "App registered: 0 ms",
      "Chat list visible: 824 ms",
      "Connection check finished: 1128 ms",
      "Chat snapshot: 1228 ms",
    ]);
    expect(loadingTimingLines(JSON.stringify(marks[0]))).toEqual([]);
  });
  it("keeps repeated marks and shows outcomes and open-relative timing", () => {
    const marks = [
      { name: "app.entry", atMs: 1 },
      { name: "chat.opened", atMs: 10, thread: "abc" },
      { name: "thread.http", atMs: 20, thread: "abc", outcome: "missing", ms: 8 },
      { name: "thread.http", atMs: 20, thread: "abc", outcome: "unavailable", ms: 8 },
      { name: "chat.opened", atMs: 30, thread: "abc" },
      { name: "thread.live", atMs: 35, thread: "abc" },
    ];
    expect(loadingTimingLines(marks.map((mark) => JSON.stringify(mark)).join("\n"))).toEqual([
      "JavaScript started: 0 ms",
      "Chat opened: 9 ms (thread=abc)",
      "Chat snapshot: 19 ms, open +10 ms (thread=abc, outcome=missing, ms=8)",
      "Chat snapshot: 19 ms, open +10 ms (thread=abc, outcome=unavailable, ms=8)",
      "Chat opened: 29 ms (thread=abc)",
      "Chat stream synchronized: 34 ms, open +5 ms (thread=abc)",
    ]);
  });
  it("shows load and attempt ids for interleaved replay stages", () => {
    const marks = [
      { name: "app.entry", atMs: 1 },
      {
        name: "thread.session.wait",
        atMs: 2,
        environment: "env",
        thread: "a",
        load: 3,
        attempt: 0,
      },
      {
        name: "thread.subscribe",
        atMs: 5,
        environment: "env",
        thread: "a",
        load: 3,
        attempt: 1,
        resume: true,
        sequence: 42,
      },
      {
        name: "thread.first",
        atMs: 8,
        environment: "env",
        thread: "a",
        load: 3,
        attempt: 1,
        kind: "event",
        items: 2,
      },
      { name: "thread.live", atMs: 20, environment: "env", thread: "a", load: 3, attempt: 1 },
    ];
    const lines = loadingTimingLines(marks.map((mark) => JSON.stringify(mark)).join("\n"));
    expect(lines[1]).toContain("load=3, attempt=0");
    expect(lines[2]).toContain("load=3, attempt=1");
    expect(lines[2]).toContain("resume=true, sequence=42");
    expect(lines[3]).toContain("First chat stream frame");
    expect(lines[4]).toContain("Chat stream synchronized");
  });
  it("includes module evaluation in new journals and still resets on legacy launches", () => {
    const marks = [
      { name: "app.entry", atMs: 1000 },
      { name: "app.launch", atMs: 1200 },
      { name: "home.list.visible", atMs: 2000 },
    ];
    expect(loadingTimingLines(marks.map((mark) => JSON.stringify(mark)).join("\n"))).toEqual([
      "JavaScript started: 0 ms",
      "App registered: 200 ms",
      "Chat list visible: 1000 ms",
    ]);
    marks.push({ name: "app.launch", atMs: 3000 });
    expect(loadingTimingLines(marks.map((mark) => JSON.stringify(mark)).join("\n"))).toEqual([
      "App registered: 0 ms",
    ]);
  });
});
