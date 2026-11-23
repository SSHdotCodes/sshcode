import { useRef, useState } from "react";
import {
  CHAT_TAB_ICON_SIZE,
  cleanChatTabName,
  isChatTabEmoji,
  type ChatTabIconInput,
} from "@t3tools/contracts";
import type { ChatTabView } from "@t3tools/client-runtime/state/chat-tabs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DiscordServerArt } from "./DiscordNavigation";

/** Decode and crop locally; the server receives only a bounded, fixed-size RGBA buffer. */
async function serverIconPixels(file: File): Promise<ChatTabIconInput> {
  if (!/^image\/(png|jpeg|webp)$/u.test(file.type) || file.size > 5 * 1024 * 1024)
    throw new Error("Choose a PNG, JPEG or WebP under 5 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = CHAT_TAB_ICON_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image editing is unavailable.");
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - size) / 2,
      (bitmap.height - size) / 2,
      size,
      size,
      0,
      0,
      CHAT_TAB_ICON_SIZE,
      CHAT_TAB_ICON_SIZE,
    );
    const bytes = context.getImageData(0, 0, CHAT_TAB_ICON_SIZE, CHAT_TAB_ICON_SIZE).data;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { kind: "image", pixels: btoa(binary) };
  } finally {
    bitmap.close();
  }
}

export function DiscordServerSettings({
  tab,
  initialName,
  onClose,
  onSave,
}: {
  tab: ChatTabView | null;
  initialName?: string | undefined;
  onClose: () => void;
  onSave: (name: string, icon: ChatTabIconInput | null | undefined) => Promise<boolean>;
}) {
  const [name, setName] = useState(tab?.name ?? initialName ?? "");
  const [emoji, setEmoji] = useState(tab?.icon?.kind === "emoji" ? tab.icon.emoji : "");
  const [icon, setIcon] = useState<ChatTabIconInput | null | undefined>();
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewTab = {
    ...(tab ?? { key: "", threadKeys: new Set<string>(), attention: false, working: false }),
    name: name || "New server",
    icon:
      icon === null
        ? undefined
        : icon?.kind === "emoji"
          ? icon
          : preview
            ? { kind: "image" as const, dataUrl: preview }
            : tab?.icon,
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        className="max-w-md"
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const clean = cleanChatTabName(name);
              if (!clean) {
                setError("Choose a name for this server.");
                return;
              }
              setBusy(true);
              void onSave(clean, icon).then((saved) => {
                setBusy(false);
                if (saved) onClose();
                else setError("Couldn’t save this server. Try again.");
              });
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{tab ? "Server settings" : "Create a server"}</DialogTitle>
          <DialogDescription>
            {tab
              ? "This server is a chat tab in the main layout."
              : "Group chats in a server. It also appears as a tab in the main layout."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="my-5 flex items-center gap-4">
            <span className="dc-server-icon" aria-hidden>
              <DiscordServerArt tab={previewTab} />
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                Upload image
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setIcon(null);
                  setEmoji("");
                  setPreview(null);
                }}
              >
                Use default
              </Button>
            </div>
            <input
              ref={fileInput}
              hidden
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Server image"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setBusy(true);
                void serverIconPixels(file)
                  .then((next) => {
                    setIcon(next);
                    setEmoji("");
                    setError(null);
                    // Preview the already-decoded pixels, never the original file or a remote URL.
                    if (next.kind === "image") {
                      const canvas = document.createElement("canvas");
                      canvas.width = canvas.height = CHAT_TAB_ICON_SIZE;
                      const bytes = Uint8ClampedArray.from(atob(next.pixels), (char) =>
                        char.charCodeAt(0),
                      );
                      canvas
                        .getContext("2d")
                        ?.putImageData(new ImageData(bytes, CHAT_TAB_ICON_SIZE), 0, 0);
                      setPreview(canvas.toDataURL("image/png"));
                    }
                  })
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Couldn’t open that image."),
                  )
                  .finally(() => setBusy(false));
              }}
            />
          </div>
          <label className="mb-4 grid gap-2 text-sm">
            Server name
            <Input
              autoFocus
              value={name}
              maxLength={32}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="mb-4 grid gap-2 text-sm">
            Emoji icon
            <Input
              value={emoji}
              placeholder="Choose one emoji"
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setEmoji(value);
                if (value === "" || isChatTabEmoji(value)) {
                  setIcon(value === "" ? null : { kind: "emoji", emoji: value });
                  setPreview(null);
                  setError(null);
                } else setError("Choose a single emoji.");
              }}
            />
          </label>
          {error ? (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (emoji !== "" && !isChatTabEmoji(emoji))}>
            {busy ? "Saving…" : tab ? "Save changes" : "Create server"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
