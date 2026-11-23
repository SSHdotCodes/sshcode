import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./assets/notification-completion.mp3", () => ({ default: "completion.mp3" }));
vi.mock("./assets/notification-input.mp3", () => ({ default: "input.mp3" }));

import { notificationSoundPlays } from "./threadNotifications";

describe("notificationSoundPlays", () => {
  it("pings for a chat that needs the user whenever sound is on", () => {
    for (const notificationMode of ["sound", "notifications-and-sound"] as const)
      for (const notificationSoundEvents of ["needs-you", "all"] as const)
        expect(notificationSoundPlays({ notificationMode, notificationSoundEvents }, "input")).toBe(
          true,
        );
  });

  it("pings for a finished turn only when those are asked for", () => {
    const sound = { notificationMode: "notifications-and-sound" as const };
    expect(
      notificationSoundPlays({ ...sound, notificationSoundEvents: "needs-you" }, "completion"),
    ).toBe(false);
    expect(notificationSoundPlays({ ...sound, notificationSoundEvents: "all" }, "completion")).toBe(
      true,
    );
  });

  it("never pings while sound is off", () => {
    for (const notificationMode of ["off", "notifications"] as const)
      for (const kind of ["input", "completion"] as const)
        expect(
          notificationSoundPlays({ notificationMode, notificationSoundEvents: "all" }, kind),
        ).toBe(false);
  });
});
