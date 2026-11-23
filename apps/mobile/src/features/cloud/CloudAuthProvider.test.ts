// @vitest-environment jsdom
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuth } from "@clerk/expo";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  CloudAuthProvider,
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
} from "./CloudAuthProvider";
import { resolveCloudPublicConfig } from "./publicConfig";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn((props: { readonly children: ReactNode }) => props.children),
  useAuth: vi.fn(() => ({
    getToken: vi.fn(async () => "clerk-token"),
    isLoaded: true,
    isSignedIn: false,
    userId: null,
  })),
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => vi.fn(async () => ({ _tag: "Success", value: undefined }))),
}));

vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
  });

  it("activates the relay session on launch without waiting for composer draft restoration", async () => {
    vi.mocked(resolveCloudPublicConfig).mockReturnValue({
      clerk: { publishableKey: "pk_test_123" },
      relay: { url: "https://relay.example.test" },
    } as ReturnType<typeof resolveCloudPublicConfig>);
    vi.mocked(useAuth).mockReturnValue({
      getToken: vi.fn(async () => "clerk-token"),
      isLoaded: true,
      isSignedIn: true,
      userId: "account-1",
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(getComposerCloudAccountId).mockResolvedValue("account-1");
    const restoreDrafts = Promise.withResolvers<void>();
    vi.mocked(restoreCloudComposerDrafts).mockReturnValue(restoreDrafts.promise);

    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    let root: Root | null = null;
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(CloudAuthProvider, null, null));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
      expect(vi.mocked(restoreCloudComposerDrafts)).toHaveBeenCalledWith("account-1");

      restoreDrafts.resolve();
      await act(async () => {
        await restoreDrafts.promise;
      });
    } finally {
      await act(async () => {
        root?.unmount();
      });
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
