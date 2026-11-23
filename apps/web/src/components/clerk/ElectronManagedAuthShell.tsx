import { createPasskeys, type PasskeySupport } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ClerkProviderProps } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

const nativePasskeys = createPasskeys({ mode: "native" });

/**
 * Ad-hoc signed desktop builds cannot hold Apple's Associated Domains
 * entitlement, so native passkeys always fail. Reporting WebAuthn unsupported
 * hides the passkey option in Clerk's modal and skips conditional autofill.
 */
export const disabledElectronPasskeys: PasskeySupport = {
  ...nativePasskeys,
  isSupported: () => false,
  isAutoFillSupported: async () => false,
  isPlatformAuthenticatorSupported: async () => false,
};

/**
 * Browser OAuth callbacks return to `t3code://app/`, which the shareable build
 * must not claim at the OS level (T3's Clerk dashboard rejects `sshcode://` and
 * loopback redirects). Hide social OAuth controls in the Electron modal so
 * sign-in uses in-window methods (email + password, email verification code,
 * TOTP/backup codes) without leaving the app.
 */
export const electronClerkAppearance = {
  ...clerkAppearance,
  elements: {
    ...clerkAppearance.elements,
    socialButtonsRoot: { display: "none" },
    dividerRow: { display: "none" },
  },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;

/**
 * Electron half of the managed-auth boundary. The Electron provider statically
 * bundles the full clerk-js runtime, so this module must only ever load
 * lazily, and only inside the desktop shell — importing it eagerly would put
 * clerk-js back into every client's startup graph.
 */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={electronClerkAppearance}
      publishableKey={publishableKey}
      passkeys={disabledElectronPasskeys}
    >
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
