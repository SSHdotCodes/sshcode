// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  readWorkspaceHtmlScripts,
  useWorkspaceHtmlScripts,
  WorkspaceHtmlScriptsBar,
} from "./WorkspaceHtmlScripts";

function Preview(props: { environment: string; path: string }) {
  const [allowed, setAllowed] = useWorkspaceHtmlScripts(props.environment, props.path);
  return <WorkspaceHtmlScriptsBar allowed={allowed} onChange={setAllowed} />;
}

it("remembers the choice for each environment and file, and can turn scripts off", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (environment: string, path: string) =>
    act(async () => root.render(<Preview environment={environment} path={path} />));
  const click = () => act(async () => host.querySelector("button")!.click());
  try {
    await render("one", "/repo/a.html");
    expect(host.textContent).toContain("Scripts are off for this file");
    await click();
    expect(host.textContent).toContain("Turn scripts off");
    expect(readWorkspaceHtmlScripts("one", "/repo/a.html")).toBe(true);
    expect(readWorkspaceHtmlScripts("two", "/repo/a.html")).toBe(false);
    await render("one", "/repo/b.html");
    expect(host.textContent).toContain("Scripts are off for this file");
    await render("two", "/repo/a.html");
    expect(host.textContent).toContain("Scripts are off for this file");
    await render("one", "/repo/a.html");
    expect(host.textContent).toContain("Turn scripts off");
    await click();
    await render("one", "/repo/b.html");
    await render("one", "/repo/a.html");
    expect(host.textContent).toContain("Scripts are off for this file");
    expect(readWorkspaceHtmlScripts("one", "/repo/a.html")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});
