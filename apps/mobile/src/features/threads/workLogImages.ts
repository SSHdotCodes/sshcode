import {
  isChatAttachmentImagePath,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";

import type { ThreadFeedActivity } from "../../lib/threadActivity";

/**
 * Where a tool call's picture comes from without expanding it:
 * - `viewed`: the call read an image file; its path is on the row.
 * - `tool-output`: the call likely returned image content. The timeline withholds
 *   tool output, so the row fetches its detail to learn how many images it holds.
 */
export type WorkActivityImageSource =
  | { readonly kind: "viewed"; readonly activity: ThreadFeedActivity; readonly path: string }
  | { readonly kind: "tool-output"; readonly activity: ThreadFeedActivity };

// Tool names that return pictures: screenshot tools across MCP servers and agents,
// and image viewers or generators. Matched against snake_case names.
const IMAGE_TOOL_NAME =
  /screen_?shot|screencap|screen_?capture|capture_?screen|(?:^|_)(?:view|read|get|show|take|capture|generate|create|edit)_(?:image|photo|picture)s?(?:_|$)|^image_?gen/;
const IMAGE_ACTION = /screenshot|zoom/i;
const IMAGE_INPUT_FLAGS = ["includeImage", "include_image", "includeScreenshot", "screenshot"];

function toolNameWords(name: string): string {
  // `mcp__server__take_screenshot` and `takeScreenshot` both become `take_screenshot`.
  const local = name.split("__").at(-1) ?? name;
  return local
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

/** Inputs that ask for a picture, such as `{ action: "screenshot" }` or `{ includeImage: true }`. */
function inputRequestsImage(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (typeof record.action === "string" && IMAGE_ACTION.test(record.action)) return true;
  return IMAGE_INPUT_FLAGS.some((flag) => record[flag] === true);
}

const sourceCache = new WeakMap<ThreadFeedActivity, WorkActivityImageSource | null>();

export function workActivityImageSource(
  activity: ThreadFeedActivity,
): WorkActivityImageSource | null {
  const cached = sourceCache.get(activity);
  if (cached !== undefined) return cached;
  const source = resolveWorkActivityImageSource(activity);
  sourceCache.set(activity, source);
  return source;
}

function resolveWorkActivityImageSource(
  activity: ThreadFeedActivity,
): WorkActivityImageSource | null {
  if (activity.status === "failure") return null;
  const path = workEntryViewedImagePath(activity.workEntry);
  if (path !== null)
    return isChatAttachmentImagePath(path) ? null : { kind: "viewed", activity, path };
  const item = activity.projectedItem.item;
  // Output exists once the call finishes; the wire marks withheld output.
  if (item.type !== "dynamic_tool" || item.status !== "completed" || item.outputOmitted !== true)
    return null;
  return (item.toolName !== null && IMAGE_TOOL_NAME.test(toolNameWords(item.toolName))) ||
    inputRequestsImage(item.input)
    ? { kind: "tool-output", activity }
    : null;
}

const groupCache = new WeakMap<
  ReadonlyArray<ThreadFeedActivity>,
  ReadonlyArray<WorkActivityImageSource>
>();

/** Image sources of a work group, in call order. Cached per group for list sizing. */
export function workGroupImageSources(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<WorkActivityImageSource> {
  let sources = groupCache.get(activities);
  if (!sources) {
    sources = activities.flatMap((activity) => workActivityImageSource(activity) ?? []);
    groupCache.set(activities, sources);
  }
  return sources;
}

/** Keep generation failures and unavailable images visible while work is collapsed. */
export function workGroupImageNotices(activities: ReadonlyArray<ThreadFeedActivity>): string[] {
  return [
    ...new Set(
      activities.flatMap((activity) => {
        const item = activity.projectedItem.item;
        return item.type === "dynamic_tool" &&
          item.toolName === "image_gen" &&
          item.title?.startsWith("Generated image: ")
          ? [item.title]
          : [];
      }),
    ),
  ];
}
