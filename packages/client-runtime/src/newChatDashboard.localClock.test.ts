import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildNewChatActivity,
  formatQuotaReset,
  formatScheduledTaskStart,
} from "./newChatDashboard.ts";

// The dashboard's days and times follow the viewer's clock, here one far from New York.
vi.stubEnv("TZ", "Asia/Tokyo");

const environmentId = EnvironmentId.make("machine-a");

describe("new chat dashboard on the viewer's clock", () => {
  it("counts a chat on the viewer's calendar day", () => {
    // 2026-11-05 20:00 UTC is Nov 6, 5 AM in Tokyo (and still Nov 5 in New York).
    const activity = buildNewChatActivity(
      [
        {
          id: ThreadId.make("early-tokyo-morning"),
          environmentId,
          createdAt: "2026-11-05T20:00:00.000Z",
          deletedAt: null,
          visibleItemCount: 1,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: ThreadId.make("early-tokyo-morning"),
          },
        },
      ],
      environmentId,
      Date.parse("2026-11-07T12:00:00+09:00"),
    );
    expect(activity.days.find((day) => day.date === "2026-11-06")?.count).toBe(1);
    expect(activity.days.find((day) => day.date === "2026-11-05")?.count).toBe(0);
  });

  it("shows resets and task starts in the viewer's time, with no zone suffix", () => {
    expect(formatQuotaReset("2026-12-01T16:05:00Z")).toBe("Dec 2, 1:05 AM");
    expect(formatScheduledTaskStart("2026-11-07T04:10:00.000Z")).toBe("1:10 PM");
  });
});
