// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipScrollDismissArea,
  TooltipTrigger,
} from "./tooltip";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Tooltip lazy mounting", () => {
  it("defers popup children until hovered and preserves trigger DOM identity and refs", async () => {
    const popupContentRender = vi.fn();
    function PopupBody() {
      popupContentRender();
      return <span>Lazy tooltip content</span>;
    }

    let capturedNode: HTMLButtonElement | null = null;
    function Harness() {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <TooltipProvider delay={100} closeDelay={0}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={(node) => {
                    ref.current = node;
                    capturedNode = node;
                  }}
                  type="button"
                >
                  Hover me
                </button>
              }
            />
            <TooltipPopup>
              <PopupBody />
            </TooltipPopup>
          </Tooltip>
        </TooltipProvider>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });

    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger).toBeTruthy();
    expect(capturedNode).toBe(trigger);
    expect(popupContentRender).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();

    // Hover opens after delay without remounting the trigger element.
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(110);
    });

    expect(container.querySelector("button")).toBe(trigger);
    expect(popupContentRender).toHaveBeenCalled();
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
      "Lazy tooltip content",
    );

    // Leaving closes and unmounts the popup.
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseleave"));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  });

  it("opens on keyboard focus without losing focus, dismisses on Escape and blur, and respects disabled", async () => {
    function Harness() {
      const [disabled, setDisabled] = useState(false);
      return (
        <>
          <button type="button" data-testid="toggle" onClick={() => setDisabled((v) => !v)}>
            toggle
          </button>
          <Tooltip disabled={disabled}>
            <TooltipTrigger>Focusable</TooltipTrigger>
            <TooltipPopup>Focus help</TooltipPopup>
          </Tooltip>
        </>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tooltip-trigger"]')!;
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!;

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
      "Focus help",
    );

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Re-focus while disabled does not open.
    await act(async () => {
      trigger.blur();
      toggle.click();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      trigger.focus();
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  });

  it("cancels delayed hover on scroll and suppresses outer tooltip when hovering a nested trigger", async () => {
    await act(async () => {
      root.render(
        <TooltipProvider delay={150} closeDelay={0}>
          <TooltipScrollDismissArea>
            <div data-testid="scroll-host">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div role="button" tabIndex={0} data-testid="outer">
                      Outer
                      <Tooltip>
                        <TooltipTrigger
                          delay={50}
                          render={
                            <button type="button" data-testid="inner">
                              Inner
                            </button>
                          }
                        />
                        <TooltipPopup>Inner tip</TooltipPopup>
                      </Tooltip>
                    </div>
                  }
                />
                <TooltipPopup>Outer tip</TooltipPopup>
              </Tooltip>
            </div>
          </TooltipScrollDismissArea>
        </TooltipProvider>,
      );
    });

    const outer = container.querySelector<HTMLElement>('[data-testid="outer"]')!;
    const inner = container.querySelector<HTMLElement>('[data-testid="inner"]')!;
    const scrollHost = container.querySelector<HTMLElement>('[data-testid="scroll-host"]')!;

    // Hovering outer then moving onto nested inner cancels outer and shows only inner.
    await act(async () => {
      outer.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      outer.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(160);
    });
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
      "Outer tip",
    );

    await act(async () => {
      inner.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      inner.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(60);
    });
    const openPopups = [...document.querySelectorAll('[data-slot="tooltip-popup"][data-open]')];
    expect(openPopups.map((el) => el.textContent)).toEqual(["Inner tip"]);

    // Scrolling dismisses the active hover tooltip.
    await act(async () => {
      scrollHost.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  });

  it("closes an open tooltip cleanly when its subtree is hidden via Activity", async () => {
    const { Activity } = await import("react");
    function Harness({ hidden }: { readonly hidden: boolean }) {
      return (
        <Activity mode={hidden ? "hidden" : "visible"}>
          <Tooltip>
            <TooltipTrigger delay={0}>Action</TooltipTrigger>
            <TooltipPopup>Hidden pane tip</TooltipPopup>
          </Tooltip>
        </Activity>
      );
    }

    await act(async () => {
      root.render(<Harness hidden={false} />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tooltip-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
      "Hidden pane tip",
    );

    await act(async () => {
      root.render(<Harness hidden={true} />);
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  });
  it("treats a trigger's disabled as tooltip-disabled and never disables the element", async () => {
    const onClick = vi.fn();
    function Harness({ disabled }: { readonly disabled: boolean }) {
      return (
        <>
          <Tooltip>
            <TooltipTrigger
              disabled={disabled}
              delay={0}
              render={
                <button type="button" data-testid="rendered" onClick={onClick}>
                  Reset
                </button>
              }
            />
            <TooltipPopup>Reset tip</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger disabled={disabled} data-testid="plain">
              Plain
            </TooltipTrigger>
            <TooltipPopup>Plain tip</TooltipPopup>
          </Tooltip>
        </>
      );
    }
    const hover = async (element: HTMLElement) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseenter"));
        await vi.advanceTimersByTimeAsync(700);
      });
    };
    const openPopups = () =>
      [...document.querySelectorAll('[data-slot="tooltip-popup"][data-open]')].map(
        (element) => element.textContent,
      );

    await act(async () => {
      root.render(<Harness disabled />);
    });
    const rendered = container.querySelector<HTMLButtonElement>('[data-testid="rendered"]')!;
    const plain = container.querySelector<HTMLButtonElement>('[data-testid="plain"]')!;
    expect(rendered.disabled).toBe(false);
    expect(plain.disabled).toBe(false);
    // A disabled trigger is not one a parent tooltip yields to, as in Base UI.
    expect(rendered.hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
    expect(rendered.hasAttribute("data-trigger-disabled")).toBe(true);
    await hover(rendered);
    await hover(plain);
    expect(openPopups()).toEqual([]);
    await act(async () => {
      rendered.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<Harness disabled={false} />);
    });
    expect(rendered.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
    expect(rendered.hasAttribute("data-popup-open")).toBe(false);
    await hover(rendered);
    expect(openPopups()).toEqual(["Reset tip"]);
    // Like a Base UI trigger, it marks itself while its tooltip is open.
    expect(rendered.hasAttribute("data-popup-open")).toBe(true);

    // Disabling the trigger while its tooltip is open closes it.
    await act(async () => {
      root.render(<Harness disabled />);
    });
    expect(openPopups()).toEqual([]);
    expect(rendered.hasAttribute("data-popup-open")).toBe(false);
  });

  it("keeps a controlled tooltip nested in a lazy one on its own state", async () => {
    function Harness({ innerOpen }: { readonly innerOpen: boolean }) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <div role="button" tabIndex={0} data-testid="outer">
                Outer
                <Tooltip open={innerOpen} onOpenChange={() => {}}>
                  <TooltipTrigger render={<button type="button">Inner</button>} />
                  <TooltipPopup>Inner tip</TooltipPopup>
                </Tooltip>
              </div>
            }
          />
          <TooltipPopup>Outer tip</TooltipPopup>
        </Tooltip>
      );
    }
    const openPopups = () =>
      [...document.querySelectorAll('[data-slot="tooltip-popup"][data-open]')].map(
        (element) => element.textContent,
      );

    await act(async () => {
      root.render(<Harness innerOpen />);
    });
    expect(openPopups()).toEqual(["Inner tip"]);

    await act(async () => {
      root.render(<Harness innerOpen={false} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const outer = container.querySelector<HTMLElement>('[data-testid="outer"]')!;
    await act(async () => {
      outer.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      outer.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(openPopups()).toEqual(["Outer tip"]);
  });

  it("opens on focus only when the browser calls it focus-visible, if it can tell", async () => {
    await act(async () => {
      root.render(
        <Tooltip>
          <TooltipTrigger>Focusable</TooltipTrigger>
          <TooltipPopup>Focus help</TooltipPopup>
        </Tooltip>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tooltip-trigger"]')!;
    const matches = Element.prototype.matches;
    const focusWith = async (focusVisible: (element: Element) => boolean) => {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        const spy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (
          this: Element,
          selector: string,
        ) {
          return selector === ":focus-visible" ? focusVisible(this) : matches.call(this, selector);
        });
        try {
          trigger.focus();
        } finally {
          spy.mockRestore();
        }
      });
    };
    // Registers keyboard modality tracking for this document.
    await focusWith(() => false);
    await act(async () => {
      trigger.blur();
    });

    // A keystroke happened, but the browser says this focus is not focus-visible.
    await focusWith(() => false);
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
    await act(async () => {
      trigger.blur();
    });

    // Without :focus-visible support, the last keystroke decides.
    await focusWith(() => {
      throw new SyntaxError("unsupported selector");
    });
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
      "Focus help",
    );
  });
});
