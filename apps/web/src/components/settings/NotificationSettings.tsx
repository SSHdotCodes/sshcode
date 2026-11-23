import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  NOTIFICATION_SOUND_EVENT_LABELS,
  playNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const soundEvents = useScopedSettings((settings) => settings.notificationSoundEvents);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "System alerts when a chat finishes, fails, or needs you, while SSHCode is open on this device."
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio();
              if (hasDesktopNotifications(value)) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                try {
                  const permission = await Notification.requestPermission();
                  if (permission !== "granted") {
                    setPermissionMessage(
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    );
                    return;
                  }
                } catch {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                } finally {
                  setRequesting(false);
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Chat notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {hasNotificationSound(mode) ? (
        <SettingsRow
          {...searchableSetting("notification-sound")}
          description="Which chats ping. A chat needs you when it asks a question, wants approval, fails or hits a limit."
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  unlockNotificationAudio();
                  void playNotificationSound("input", () => true);
                }}
              >
                Play
              </Button>
              <Select
                value={soundEvents}
                onValueChange={(value) => {
                  if (value !== "needs-you" && value !== "all") return;
                  updateSettings({ notificationSoundEvents: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Sound for">
                  <SelectValue>{NOTIFICATION_SOUND_EVENT_LABELS[soundEvents]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(NOTIFICATION_SOUND_EVENT_LABELS).map(([value, label]) => (
                    <SelectItem key={value} hideIndicator value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
      ) : null}
    </>
  );
}
