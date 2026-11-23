// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { OutsideAgentSignIn } from "@t3tools/contracts";

import { OutsideAgentApproval } from "./OutsideAgentApproval";
import { MCP_APPS } from "./mcp/mcpApps";

const planted: OutsideAgentSignIn = {
  id: "planted",
  code: "4821",
  clientName: "Claude - enter 4821",
  redirectHost: "attacker.test",
  requestedAt: 1,
  expiresAt: 9999999999999,
};
const own: OutsideAgentSignIn = {
  ...planted,
  id: "own",
  code: "0042",
  clientName: "My app",
  redirectHost: "my-app.test",
  requestedAt: 2,
};
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
async function mount(pending = [planted, own]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const answer = vi.fn(async () => true);
  const render = async (requests: OutsideAgentSignIn[]) => {
    await act(async () =>
      root.render(
        <OutsideAgentApproval
          pending={requests}
          access="read-only"
          app={MCP_APPS[0]!}
          onAnswer={answer}
        />,
      ),
    );
  };
  await render(pending);
  const input = container.querySelector("input")!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  return { container, input, type, click, answer, render };
}

it("reveals no request name, host, code or approval button before a typed match", async () => {
  const view = await mount();
  expect(view.input.value).toBe("");
  expect(view.container.textContent).toContain("2 sign-ins waiting");
  for (const value of [
    planted.clientName,
    planted.redirectHost,
    planted.code,
    own.clientName,
    own.redirectHost,
    own.code,
  ])
    expect(view.container.textContent).not.toContain(value);
  expect(view.container.querySelectorAll("button")).toHaveLength(0);
  await view.type("004");
  expect(view.container.textContent).not.toContain(own.clientName);
  await view.type("9999");
  expect(view.container.textContent).toContain(
    "No sign-in has that code. Check the page in your browser.",
  );
  expect(view.container.textContent).not.toContain(planted.clientName);
  expect(view.container.querySelectorAll("button")).toHaveLength(0);
  expect(view.answer).not.toHaveBeenCalled();
});

it("matches the typed code even when a planted request is first, then sends that exact code on Allow", async () => {
  const view = await mount();
  await view.type("00 42");
  expect(view.input.value).toBe("0042");
  expect(view.container.textContent).toContain(own.clientName);
  expect(view.container.textContent).toContain(own.redirectHost);
  expect(view.container.textContent).toContain("Read only");
  expect(view.container.textContent).not.toContain(planted.clientName);
  expect(view.container.textContent).not.toContain(planted.redirectHost);
  expect(view.answer).not.toHaveBeenCalled();
  await view.click("Allow");
  expect(view.answer).toHaveBeenCalledExactlyOnceWith({
    _tag: "approve",
    id: own.id,
    access: "read-only",
    code: "0042",
  });
  expect(view.input.value).toBe("");
  expect(view.container.textContent).not.toContain(own.clientName);
});

it("hides a replaced request immediately and allows denial only after a match", async () => {
  const view = await mount();
  await view.type("0042");
  await view.render([planted, { ...own, id: "replacement", code: "1234" }]);
  expect(view.container.textContent).not.toContain(own.clientName);
  expect(view.container.querySelectorAll("button")).toHaveLength(0);
  await view.type("1234");
  await view.click("Deny");
  expect(view.answer).toHaveBeenCalledExactlyOnceWith({ _tag: "deny", id: "replacement" });
});
