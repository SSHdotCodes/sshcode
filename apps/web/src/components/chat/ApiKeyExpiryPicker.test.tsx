import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

import { ApiKeyExpiryPicker } from "./ApiKeyExpiryPicker";

let renderer: ReactTestRenderer;
const expiry = new Date(2026, 11, 25, 23, 59, 59).getTime();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 16, 12).getTime());
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(value: number | null = expiry) {
  function Picker() {
    const [current, setCurrent] = useState(value);
    return <ApiKeyExpiryPicker value={current} onChange={setCurrent} />;
  }
  await act(async () => {
    renderer = create(<Picker />);
  });
}

async function click(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes(label))!;
  await act(async () => button.props.onClick());
}

it("shows the saved custom deletion date when editing an existing expiry", async () => {
  await render();
  expect(renderer.root.findByType("input").props.value).toBe("2026-12-25");
  expect(
    renderer.root.findAllByType("button").filter((node) => node.props["aria-pressed"]),
  ).toHaveLength(1);
});

it("keeps the chosen custom date visible when Custom date is pressed again", async () => {
  await render(null);
  await click("Custom date");
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ currentTarget: { value: "2026-12-31" } }),
  );
  await click("Custom date");
  expect(renderer.root.findByType("input").props.value).toBe("2026-12-31");
});

it("switches from a preset to one custom selection with the same date prefilled", async () => {
  await render(null);
  await click("7 days");
  await click("Custom date");
  expect(renderer.root.findByType("input").props.value).toBe("2026-10-23");
  expect(
    renderer.root
      .findAllByType("button")
      .filter((node) => node.props["aria-pressed"])
      .map((node) => node.children.join("")),
  ).toEqual(["Custom date"]);
});

it("reflects an expiry changed by the parent instead of leaving Never selected", async () => {
  const onChange = vi.fn();
  await act(async () => {
    renderer = create(<ApiKeyExpiryPicker value={null} onChange={onChange} />);
  });
  await act(async () => {
    renderer.update(<ApiKeyExpiryPicker value={expiry} onChange={onChange} />);
  });
  expect(renderer.root.findByType("input").props.value).toBe("2026-12-25");
});
