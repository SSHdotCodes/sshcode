import { describe, expect, it } from "vite-plus/test";

import { clerkAppearance } from "./clerkAppearance";
import { disabledElectronPasskeys, electronClerkAppearance } from "./ElectronManagedAuthShell";

describe("ElectronManagedAuthShell", () => {
  it("hides browser OAuth social buttons and divider while preserving theme appearance", () => {
    expect(electronClerkAppearance.variables).toEqual(clerkAppearance.variables);
    expect(electronClerkAppearance.elements).toMatchObject({
      ...clerkAppearance.elements,
      socialButtonsRoot: { display: "none" },
      dividerRow: { display: "none" },
    });
  });

  it("disables passkeys for ad-hoc signed Electron builds", async () => {
    expect(disabledElectronPasskeys.isSupported()).toBe(false);
    expect(await disabledElectronPasskeys.isAutoFillSupported()).toBe(false);
    expect(await disabledElectronPasskeys.isPlatformAuthenticatorSupported()).toBe(false);

    const getResult = await disabledElectronPasskeys.get({
      publicKeyOptions: {
        allowCredentials: [],
        challenge: new Uint8Array([1]),
        rpId: "clerk.t3.codes",
        timeout: 60_000,
        userVerification: "preferred",
      },
      conditionalUI: false,
    });
    expect(getResult.publicKeyCredential).toBeNull();
    expect(getResult.error).toMatchObject({ code: "passkey_not_supported" });
  });
});
