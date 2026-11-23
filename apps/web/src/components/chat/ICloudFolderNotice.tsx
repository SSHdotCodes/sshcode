import { useState } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";

export function ICloudFolderNotice({ chatKey }: { chatKey: string }) {
  const storageKey = `sshcode:icloud-notice:${chatKey}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "dismissed";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <Alert className="pointer-events-auto" variant="info" surface="glass" role="status">
      <InfoIcon />
      <AlertDescription>
        This folder syncs to iCloud. Agents can create many files here, which slows iCloud and fills
        your disk.
      </AlertDescription>
      <AlertAction>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Dismiss iCloud notice"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(storageKey, "dismissed");
            } catch {
              /* Storage may be unavailable. */
            }
          }}
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}
