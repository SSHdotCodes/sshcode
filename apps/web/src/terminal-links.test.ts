import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  isTerminalUrl,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("classifies uppercase schemes as URLs at activation time too", () => {
    expect(isTerminalUrl("HTTPS://example.com/docs")).toBe(true);
    expect(isTerminalUrl("Http://example.com")).toBe(true);
    expect(isTerminalUrl("src/components/main.ts")).toBe(false);
    expect(isTerminalUrl("httpsdocs/readme.md")).toBe(false);
  });

  it("finds URLs regardless of scheme casing", () => {
    expect(extractTerminalLinks("open HTTPS://example.com/docs")).toEqual([
      {
        kind: "url",
        text: "HTTPS://example.com/docs",
        start: 5,
        end: 29,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });

  it("keeps a trailing colon on URLs", () => {
    expect(extractTerminalLinks("GET https://example.test/items/foo:")).toEqual([
      { kind: "url", text: "https://example.test/items/foo:", start: 4, end: 35 },
    ]);
  });

  it.each([
    ["./main.go:10:5: undefined: x", "./main.go:10:5"],
    ["/home/dev/app/src/main.c:10:5: error: expected ';'", "/home/dev/app/src/main.c:10:5"],
    ["C:\\dev\\app\\src\\main.c:10:5: error: expected ';'", "C:\\dev\\app\\src\\main.c:10:5"],
    ["wrote ./out/report.txt:", "./out/report.txt"],
  ])("drops the colon that ends a compiler diagnostic location in %s", (line, text) => {
    const start = line.indexOf(text);
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start, end: start + text.length },
    ]);
  });

  it.each([
    [
      "/app/src/Program.cs(12,5): error CS1002: ; expected",
      "/app/src/Program.cs(12,5)",
      "/app/src/Program.cs:12:5",
    ],
    [
      String.raw`C:\app\UnitTest1.cs(12): error VSTEST1: Assert.True() Failure`,
      String.raw`C:\app\UnitTest1.cs(12)`,
      String.raw`C:\app\UnitTest1.cs:12`,
    ],
    [
      "#0 /var/www/html/index.php(110): handle()",
      "/var/www/html/index.php(110)",
      "/var/www/html/index.php:110",
    ],
    [
      "src/Program.cs(12,5): warning CS0168: unused variable",
      "src/Program.cs(12,5)",
      "src/Program.cs:12:5",
    ],
    [
      "source.cpp(12): warning C4101: unreferenced local variable",
      "source.cpp(12)",
      "source.cpp:12",
    ],
    ["wrote /app/report(1): done", "/app/report(1)", "/app/report(1)"],
    ["see /(60)", "/(60)", "/(60)"],
    [
      "see https://example.com/wiki/Dune_(2021)",
      "https://example.com/wiki/Dune_(2021)",
      "https://example.com/wiki/Dune_(2021)",
    ],
  ])("preserves the clickable range of %s", (line, printed, target) => {
    const start = line.indexOf(printed);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: isTerminalUrl(printed) ? "url" : "path",
        text: target,
        start,
        end: start + printed.length,
      },
    ]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  it("keeps the line and column of a compiler diagnostic", () => {
    const [link] = extractTerminalLinks("/Users/julius/project/main.c:10:5: error: expected ';'");
    expect(resolvePathLinkTarget(link?.text ?? "", "/Users/julius/project")).toBe(
      "/Users/julius/project/main.c:10:5",
    );
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });
});
