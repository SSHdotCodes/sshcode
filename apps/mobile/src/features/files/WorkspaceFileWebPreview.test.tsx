// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const observed = vi.hoisted(() => ({
  executions: 0,
  lastNavigation: null as null | ((request: { isTopFrame: boolean; url: string }) => boolean),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: {
    javaScriptEnabled: boolean;
    onShouldStartLoadWithRequest: typeof observed.lastNavigation;
  }) => {
    if (props.javaScriptEnabled) observed.executions++;
    observed.lastNavigation = props.onShouldStartLoadWithRequest;
    return <div>preview</div>;
  },
}));
vi.mock("../../components/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("./FilePreviewFeedback", () => ({ FilePreviewLoading: () => null }));
vi.mock("../../components/LoadingStrip", () => ({ LoadingStrip: () => null }));
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";

it("keeps workspace scripts disabled until enabled and rejects top-frame navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed.executions = 0;
  const host = document.createElement("div");
  const root = createRoot(host);
  const uri = "https://server.example/api/assets/signed/page.html";
  try {
    await act(async () => root.render(<WorkspaceFileWebPreview uri={uri} restrictNavigation />));
    expect(observed.executions).toBe(0);
    expect(observed.lastNavigation?.({ isTopFrame: true, url: uri })).toBe(true);
    expect(observed.lastNavigation?.({ isTopFrame: true, url: "https://attacker.example/" })).toBe(
      false,
    );
    await act(async () =>
      root.render(<WorkspaceFileWebPreview uri={uri} scriptsAllowed restrictNavigation />),
    );
    expect(observed.executions).toBe(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
