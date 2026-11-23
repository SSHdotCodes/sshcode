import { describe, expect, it } from "vite-plus/test";
import {
  desktopLinkForPage,
  desktopLinkScheme,
  isDesktopLinkProtocol,
} from "./desktopLinkScheme.ts";

describe("desktop link scheme", () => {
  it("is SSHCode's own, apart from SSHCode's", () => {
    expect(desktopLinkScheme(false)).toBe("sshcode");
    expect(desktopLinkScheme(true)).toBe("sshcode-dev");
    expect(isDesktopLinkProtocol("sshcode:")).toBe(true);
    expect(isDesktopLinkProtocol("sshcode-dev:")).toBe(true);
    expect(isDesktopLinkProtocol("t3code:")).toBe(false);
    expect(isDesktopLinkProtocol("t3code-dev:")).toBe(false);
  });

  it("returns a browser to a renderer page through the link scheme", () => {
    expect(desktopLinkForPage("t3code://app/settings/providers?instanceId=work")).toBe(
      "sshcode://app/settings/providers?instanceId=work",
    );
    expect(desktopLinkForPage("t3code-dev://app/welcome#agents:machine-id")).toBe(
      "sshcode-dev://app/welcome#agents:machine-id",
    );
    expect(desktopLinkForPage("http://127.0.0.1:3873/welcome")).toBe(
      "http://127.0.0.1:3873/welcome",
    );
    expect(desktopLinkForPage("https://app.t3.codes/settings")).toBe(
      "https://app.t3.codes/settings",
    );
  });
});
