import { beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import {
  dismissProviderUpdateNotification,
  isProviderUpdateNotificationDismissed,
  PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
} from "./providerUpdateDismissal";

describe("providerUpdateDismissal", () => {
  beforeEach(() => {
    removeLocalStorageItem(PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY);
  });

  it("persists provider update dismissals by notification key", () => {
    expect(isProviderUpdateNotificationDismissed("opencode:1.14.33")).toBe(false);

    dismissProviderUpdateNotification("opencode:1.14.33");

    expect(isProviderUpdateNotificationDismissed("opencode:1.14.33")).toBe(true);
    expect(isProviderUpdateNotificationDismissed("opencode:1.14.34")).toBe(false);
  });
  it("keeps equal-version registry instances and future releases independently dismissible", () => {
    dismissProviderUpdateNotification("kimi-main:2.0.0");
    expect(isProviderUpdateNotificationDismissed("kimi-main:2.0.0")).toBe(true);
    expect(isProviderUpdateNotificationDismissed("vibe-main:2.0.0")).toBe(false);
    expect(isProviderUpdateNotificationDismissed("kimi-main:2.1.0")).toBe(false);
  });
});
