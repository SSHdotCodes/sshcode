// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));
import { useWorkspaceHtmlScripts } from "./workspaceHtmlScripts";

function Preview({ environment, path }: { environment: string; path: string }) {
  const scripts = useWorkspaceHtmlScripts(environment, path);
  return (
    <button onClick={() => scripts.setAllowed(!scripts.allowed)}>
      {scripts.allowed ? "on" : "off"}
    </button>
  );
}

it("remembers the script choice for each file and environment", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage.clear();
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (environment: string, path: string) =>
    act(async () => root.render(<Preview environment={environment} path={path} />));
  const click = () => act(async () => host.querySelector("button")!.click());
  try {
    await render("one", "/repo/a.html");
    expect(host.textContent).toBe("off");
    await click();
    expect(host.textContent).toBe("on");
    await render("one", "/repo/b.html");
    expect(host.textContent).toBe("off");
    await render("two", "/repo/a.html");
    expect(host.textContent).toBe("off");
    await render("one", "/repo/a.html");
    expect(host.textContent).toBe("on");
    await click();
    await render("one", "/repo/b.html");
    await render("one", "/repo/a.html");
    expect(host.textContent).toBe("off");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    storage.clear();
  }
});
