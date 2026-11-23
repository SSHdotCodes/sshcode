import { describe, expect, it } from "vite-plus/test";
import { deferredScreen } from "./deferred-screen";

describe("deferred screens", () => {
  it("does not initialize a route module until rendering and shares it across mounts", () => {
    let initialized = 0;
    const Component = () => null;
    const Screen = deferredScreen(() => {
      initialized++;
      return Component;
    });
    const route = { screen: Screen, linking: "settings/:id" };
    expect(initialized).toBe(0);
    expect(route.linking).toBe("settings/:id");
    expect(Screen({}).type).toBe(Component);
    expect(Screen({}).type).toBe(Component);
    expect(initialized).toBe(1);
  });

  it("allows the existing screen error boundary to retry a failed module load", () => {
    let attempts = 0;
    const Screen = deferredScreen(() => {
      if (++attempts === 1) throw new Error("initialization failed");
      return () => null;
    });
    expect(() => Screen({})).toThrow("initialization failed");
    expect(() => Screen({})).not.toThrow();
    expect(attempts).toBe(2);
  });
});
