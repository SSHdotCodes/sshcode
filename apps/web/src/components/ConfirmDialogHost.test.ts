import { describe, expect, it } from "vite-plus/test";

import { confirmButtonLabel } from "./ConfirmDialogHost";

describe("confirmButtonLabel", () => {
  it("names the action a question leads with", () => {
    expect(confirmButtonLabel("Delete “Release notes”?")).toBe("Delete");
    expect(confirmButtonLabel("Roll back to this checkpoint?")).toBe("Roll back");
    expect(confirmButtonLabel("archive 3 chats?")).toBe("Archive");
    expect(confirmButtonLabel("Install update 1.2 and restart SSHCode?")).toBe("Install");
    expect(confirmButtonLabel("Rotate this webhook URL?")).toBe("Rotate");
    expect(confirmButtonLabel("Allow figma to run Export?")).toBe("Allow");
    expect(confirmButtonLabel("Close browser while the agent is using it?")).toBe("Close");
  });

  it("keeps Confirm when no clear verb leads, or the verb is Cancel", () => {
    expect(confirmButtonLabel("Are you sure?")).toBe("Confirm");
    expect(confirmButtonLabel("Cancel 3 queued runs?")).toBe("Confirm");
    expect(confirmButtonLabel("Confirm action")).toBe("Confirm");
  });
});
