import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveCurrentOriginPairingUrl,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});

describe("resolveCurrentOriginPairingUrl", () => {
  it.each([
    ["t3code-dev://app/settings/connections", null],
    ["t3code://app/settings/connections", null],
    ["http://127.0.0.1:3774/settings", null],
    ["http://localhost:5173/", null],
    ["https://host.example.ts.net/settings", "https://host.example.ts.net/pair#token=abc"],
    ["http://192.168.1.20:3773/", "http://192.168.1.20:3773/pair#token=abc"],
  ])("from %s", (href, expected) => {
    expect(resolveCurrentOriginPairingUrl("abc", href)).toBe(expected);
  });
});
