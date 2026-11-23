import { describe, expect, it, vi } from "vite-plus/test";
import { createSidebarPendingActions } from "./Sidebar.optimistic";

describe("sidebar optimistic action controls", () => {
  it("never dispatches an action without a ticket, including a rejected duplicate", async () => {
    const actions = createSidebarPendingActions();
    const perform = vi.fn(async () => "dispatched");
    expect(await actions.run(null, perform)).toBeNull();
    const entry = actions.begin("chat", "pin");
    const duplicate = actions.begin("chat", "settle");
    expect(await actions.run(duplicate, perform)).toBeNull();
    expect(perform).not.toHaveBeenCalled();
    expect(actions.snapshot().get("chat")).toBe(entry);
  });

  it("never dispatches an expired ticket or clears the newer entry", async () => {
    const actions = createSidebarPendingActions();
    const old = actions.begin("chat", "pin");
    actions.cancel();
    const next = actions.begin("chat", "unpin");
    const perform = vi.fn(async () => "dispatched");
    expect(await actions.run(old, perform)).toBeNull();
    expect(perform).not.toHaveBeenCalled();
    expect(actions.snapshot().get("chat")).toBe(next);
  });

  it.each([
    ["unsettle", "settle"],
    ["unsnooze", "snooze"],
    ["unpin", "pin"],
  ] as const)(
    "holds %s against repeated and opposite actions until rejection",
    async (reverse, forward) => {
      const actions = createSidebarPendingActions();
      const entry = actions.begin("chat", reverse);
      let reject!: () => void;
      const command = actions.run(
        entry,
        () =>
          new Promise<{ _tag: "Failure" }>((resolve) => {
            reject = () => resolve({ _tag: "Failure" });
          }),
      );
      const perform = vi.fn(async () => "dispatched");
      expect(await actions.run(actions.begin("chat", reverse), perform)).toBeNull();
      expect(await actions.run(actions.begin("chat", forward), perform)).toBeNull();
      expect(perform).not.toHaveBeenCalled();
      expect(actions.snapshot().get("chat")?.action).toBe(reverse);
      reject();
      await command;
      expect(actions.snapshot().size).toBe(0);
      const next = actions.begin("chat", forward);
      expect(next).not.toBeNull();
      expect(await actions.run(next, perform)).toBe("dispatched");
      expect(actions.snapshot().size).toBe(0);
    },
  );

  it("stays busy until the command succeeds, even if its optimistic shelf already moved", async () => {
    const actions = createSidebarPendingActions();
    const listener = vi.fn();
    const unsubscribe = actions.subscribe(listener);
    const entry = actions.begin("chat", "settle")!;
    let confirm!: () => void;
    const command = actions.run(
      entry,
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    expect(actions.snapshot().get("chat")?.action).toBe("settle");
    expect(actions.begin("chat", "snooze")).toBeNull();
    confirm();
    await command;
    expect(actions.snapshot().size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("releases controls for rejected and interrupted commands", async () => {
    const actions = createSidebarPendingActions();
    const pin = actions.begin("chat", "pin");
    await actions.run(pin, async () => ({ _tag: "Failure" }));
    expect(actions.snapshot().size).toBe(0);
    const snooze = actions.begin("chat", "snooze");
    await expect(
      actions.run(snooze, async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(actions.snapshot().size).toBe(0);
  });

  it("does not let a late failure clear a newer action after an unmount or effect replay", async () => {
    const actions = createSidebarPendingActions();
    const old = actions.begin("chat", "pin");
    let finish!: () => void;
    const previous = actions.run(
      old,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    actions.cancel();
    const next = actions.begin("chat", "snooze");
    finish();
    await previous;
    expect(actions.snapshot().get("chat")).toBe(next);
    await actions.run(next, async () => undefined);
    expect(actions.snapshot().size).toBe(0);
  });

  it("keeps actions for independent chats separate", async () => {
    const actions = createSidebarPendingActions();
    const first = actions.begin("one", "settle");
    const second = actions.begin("two", "snooze");
    await actions.run(first, async () => undefined);
    expect([...actions.snapshot().keys()]).toEqual(["two"]);
    await actions.run(second, async () => undefined);
    expect(actions.snapshot().size).toBe(0);
  });
});
