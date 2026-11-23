import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity } from "../../lib/threadActivity";
import {
  workActivityImageSource,
  workGroupImageNotices,
  workGroupImageSources,
} from "./workLogImages";

function toolCall(
  toolName: string | null,
  overrides: {
    readonly input?: unknown;
    readonly status?: string;
    readonly outputOmitted?: boolean;
    readonly viewedImagePath?: string;
    readonly failed?: boolean;
    readonly title?: string;
  } = {},
): ThreadFeedActivity {
  return {
    id: `activity:${toolName}:${JSON.stringify(overrides)}`,
    status: overrides.failed ? "failure" : "success",
    workEntry: {
      id: "entry",
      createdAt: "2026-10-15T00:00:00.000Z",
      label: toolName ?? "Tool",
      tone: "tool",
      itemType: "dynamic_tool",
      ...(overrides.viewedImagePath ? { viewedImagePath: overrides.viewedImagePath } : {}),
    },
    projectedItem: {
      item: {
        type: "dynamic_tool",
        toolName,
        input: overrides.input ?? {},
        status: overrides.status ?? "completed",
        outputOmitted: overrides.outputOmitted ?? true,
        title: overrides.title,
      },
    },
  } as unknown as ThreadFeedActivity;
}

describe("workActivityImageSource", () => {
  it("shows a viewed image from its path without fetching detail", () => {
    const activity = toolCall("view_image", { viewedImagePath: "/repo/shot.png" });
    expect(workActivityImageSource(activity)).toEqual({
      kind: "viewed",
      activity,
      path: "/repo/shot.png",
    });
  });

  it.each([
    "mcp__t3-code__device_screenshot",
    "browser_take_screenshot",
    "takeScreenshot",
    "screen_capture",
    "mcp__images__generate_image",
    "image_gen",
  ])("expects pictures from %s", (toolName) => {
    expect(workActivityImageSource(toolCall(toolName))?.kind).toBe("tool-output");
  });

  it("shows a generated file by its saved path", () => {
    const activity = toolCall("image_gen", { viewedImagePath: "/repo/generated.png" });
    expect(workActivityImageSource(activity)).toEqual({
      kind: "viewed",
      activity,
      path: "/repo/generated.png",
    });
  });

  it("recognizes inputs that ask for a picture", () => {
    expect(
      workActivityImageSource(toolCall("computer", { input: { action: "screenshot" } }))?.kind,
    ).toBe("tool-output");
    expect(
      workActivityImageSource(toolCall("preview_snapshot", { input: { includeImage: true } }))
        ?.kind,
    ).toBe("tool-output");
    expect(workActivityImageSource(toolCall("preview_snapshot"))).toBeNull();
    expect(
      workActivityImageSource(toolCall("computer", { input: { action: "click" } })),
    ).toBeNull();
  });

  it("waits for finished calls with withheld output, and skips failures", () => {
    expect(workActivityImageSource(toolCall("take_screenshot", { status: "running" }))).toBeNull();
    expect(
      workActivityImageSource(toolCall("take_screenshot", { outputOmitted: false })),
    ).toBeNull();
    expect(workActivityImageSource(toolCall("take_screenshot", { failed: true }))).toBeNull();
    expect(workActivityImageSource(toolCall("list_files"))).toBeNull();
    expect(workActivityImageSource(toolCall("read_file"))).toBeNull();
  });
});

describe("workGroupImageSources", () => {
  it("keeps generation failures and oversized notices visible", () => {
    expect(
      workGroupImageNotices([
        toolCall("image_gen", {
          failed: true,
          title: "Generated image: Image generation limit reached",
        }),
        toolCall("image_gen", { title: "Generated image: Image too large to show" }),
        toolCall("image_gen", { title: "Generated image" }),
      ]),
    ).toEqual([
      "Generated image: Image generation limit reached",
      "Generated image: Image too large to show",
    ]);
  });
  it("keeps call order and returns the same list for the same group", () => {
    const group = [
      toolCall("take_screenshot"),
      toolCall("list_files"),
      toolCall("view_image", { viewedImagePath: "/repo/b.png" }),
    ];
    const sources = workGroupImageSources(group);
    expect(sources.map((source) => source.kind)).toEqual(["tool-output", "viewed"]);
    expect(workGroupImageSources(group)).toBe(sources);
  });
});
