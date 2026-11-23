// @vitest-environment jsdom

import { Activity, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useElementState } from "./useElementState";

let root: Root;
let container: HTMLDivElement;
let renders: Array<Element | null> = [];

function Probe(props: { showBox: boolean }) {
  const [element, ref] = useElementState<HTMLDivElement>();
  renders.push(element);
  return props.showBox ? <div ref={ref} data-box /> : null;
}

// The same elements every time, so only the hook's own state can re-render Probe.
const withBox = <Probe showBox />;
const withoutBox = <Probe showBox={false} />;

const render = (props: { hidden?: boolean; showBox?: boolean }) =>
  act(async () => {
    root.render(
      <Activity mode={props.hidden ? "hidden" : "visible"}>
        {props.showBox === false ? withoutBox : withBox}
      </Activity>,
    );
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renders = [];
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps the element while an Activity hides it, without re-rendering on hide or reveal", async () => {
  await render({});
  const box = container.querySelector("[data-box]");
  expect(renders.at(-1)).toBe(box);

  renders = [];
  await render({ hidden: true });
  await render({ hidden: false });
  expect(renders).toEqual([]);
  expect(container.querySelector("[data-box]")).toBe(box);
});

it("clears the element once it leaves the document", async () => {
  await render({});
  await render({ showBox: false });
  expect(renders.at(-1)).toBeNull();
});
