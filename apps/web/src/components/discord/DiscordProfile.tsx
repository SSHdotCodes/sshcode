import { useRef, useState, useSyncExternalStore } from "react";
import { readProfile, writeProfile, resizeProfile } from "./profileImage";
import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
function read() {
  try {
    return readProfile(localStorage);
  } catch {
    return null;
  }
}
function save(image: string | null) {
  writeProfile(localStorage, image);
  for (const listener of listeners) listener();
}
export function useDiscordProfile() {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function DiscordProfileSetting() {
  const image = useDiscordProfile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsRow
      title="Profile picture"
      description="Your picture in Discord mode. Saved on this device."
      control={
        <div className="flex items-center gap-2">
          <span className="flex size-10 items-center justify-center overflow-hidden rounded-full bg-muted">
            {image ? <img src={image} alt="Your profile" className="size-10 object-cover" /> : "Y"}
          </span>
          <div>
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              Choose image
            </Button>
            <input
              ref={inputRef}
              aria-label="Choose profile picture"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void resizeProfile(file)
                  .then((image) => {
                    save(image);
                    setError(null);
                  })
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Couldn’t save that image."),
                  );
              }}
            />
          </div>
          {image ? (
            <Button variant="ghost" size="sm" onClick={() => save(null)}>
              remove
            </Button>
          ) : null}
          {error ? <span role="alert">{error}</span> : null}
        </div>
      }
    />
  );
}
