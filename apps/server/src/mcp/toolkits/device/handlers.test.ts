import { describe, expect, it } from "vite-plus/test";

import { agentDeviceQuickStart, agentDeviceTargetArgs, pngDimensions } from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

describe("device tool helpers", () => {
  it("pins agent-device commands to the device by platform-specific flag", () => {
    expect(agentDeviceTargetArgs(device)).toEqual(["--platform", "ios", "--udid", "ABCD-1234"]);
    expect(agentDeviceTargetArgs({ ...device, platform: "android", id: "emulator-5554" })).toEqual([
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
    ]);
  });

  it("writes the quick start around the pinned target", () => {
    const text = agentDeviceQuickStart(device);
    expect(text).toContain("agentDevice.targetArgs (--platform ios --udid ABCD-1234)");
    expect(text).toContain("iPhone 17 Pro (iOS 27.0)");
    expect(text).toContain("XCTest runner");
  });

  it("states the launcher and target args once for every subcommand", () => {
    const text = agentDeviceQuickStart(
      device,
      ["--session", "thread-1", "--config", "/tmp/host.json"],
      "/tmp/t3 tools/agent-device",
    );
    expect(text).toContain("agentDevice.command ('/tmp/t3 tools/agent-device')");
    expect(text).not.toContain("  agent-device ");
    expect(text).not.toContain("is on PATH");
    expect(text.match(/--session thread-1/g)).toHaveLength(1);
    expect(text.match(/\/tmp\/t3 tools\/agent-device/g)).toHaveLength(1);
    expect(text).toContain(
      "EVERY agentDevice.targetArgs (--session thread-1 --config /tmp/host.json)",
    );
    for (const command of [
      "open <bundle-or-package-id>",
      "snapshot -i",
      "click @e3",
      'fill @e5 "text"',
      "screenshot /tmp/shot.png",
      "install <app>",
      "<command> --help",
    ])
      expect(text).toContain(command);
    expect(text).toContain("concurrent devices and hosts");
    expect(text).toContain("remote hosts");
    expect(text.length).toBeLessThan(1_500);
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});
