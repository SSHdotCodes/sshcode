import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "t3code:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "t3code:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "t3-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for t3code:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "t3code:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "t3code:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});

describe("Discord mode", () => {
  it("switches the root layout, wears the Discord look and keeps a boot hint", async () => {
    const storage = createStorage();
    const style = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const classes = new Set<string>();
    const element = {
      dataset,
      classList: {
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, on?: boolean) => {
          if (on ?? !classes.has(name)) classes.add(name);
          else classes.delete(name);
        },
      },
      offsetHeight: 0,
      style: {
        getPropertyValue: (name: string) => style.get(name) ?? "",
        removeProperty: (name: string) => style.delete(name),
        setProperty: (name: string, value: string) => style.set(name, value),
      },
    };
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("document", {
      body: { style: {} },
      documentElement: element,
      head: { append: () => undefined, appendChild: () => undefined },
      createElement: () => ({ setAttribute: () => undefined }),
      querySelector: () => null,
      querySelectorAll: () => [],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "rgb(49, 51, 56)",
      getPropertyValue: () => "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());

    const { setUiModePreference, UI_MODE_STORAGE_KEY } = await import("./useTheme");
    expect(dataset.uiMode).toBeUndefined();

    expect(setUiModePreference("discord")).toBe(true);
    expect(storage.getItem(UI_MODE_STORAGE_KEY)).toBe('"discord"');
    expect(dataset.uiMode).toBe("discord");
    expect(dataset.harnessTheme).toBe("discord");
    const hint = JSON.parse(storage.getItem("t3code:ui-mode-boot:v1") ?? "null");
    expect(hint).toMatchObject({
      mode: "discord",
      dark: { background: "#17181c", foreground: "#e0e2e7", accent: "#5865f2" },
      light: { background: "#17181c", foreground: "#e0e2e7", accent: "#5865f2" },
    });

    expect(setUiModePreference("default")).toBe(true);
    expect(dataset.uiMode).toBeUndefined();
    expect(dataset.harnessTheme).toBeUndefined();
    expect(storage.getItem("t3code:ui-mode-boot:v1")).toBeNull();
  });
});

describe("theme transitions", () => {
  it("keeps transitions off through the next frame after each theme change", async () => {
    const style = new Map<string, string>();
    const classes = new Set<string>();
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: createStorage(),
      matchMedia: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("document", {
      body: { style: {} },
      documentElement: {
        dataset: {},
        classList: {
          add: (name: string) => classes.add(name),
          contains: (name: string) => classes.has(name),
          remove: (name: string) => classes.delete(name),
          toggle: (name: string, on?: boolean) => {
            if (on ?? !classes.has(name)) classes.add(name);
            else classes.delete(name);
          },
        },
        style: {
          getPropertyValue: (name: string) => style.get(name) ?? "",
          removeProperty: (name: string) => style.delete(name),
          setProperty: (name: string, value: string) => style.set(name, value),
        },
      },
      head: { append: () => undefined, appendChild: () => undefined },
      createElement: () => ({ setAttribute: () => undefined }),
      querySelector: () => null,
      querySelectorAll: () => [],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "rgb(49, 51, 56)",
      getPropertyValue: () => "",
    }));
    let frame: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frame.push(callback));
    const nextFrame = () => {
      const callbacks = frame;
      frame = [];
      for (const callback of callbacks) callback();
    };
    const { setUiModePreference } = await import("./useTheme");

    setUiModePreference("discord");
    expect(classes.has("no-transitions")).toBe(true);
    nextFrame();
    expect(classes.has("no-transitions")).toBe(true);
    nextFrame();
    expect(classes.has("no-transitions")).toBe(false);

    // A change in the frame between keeps them off until its own next frame.
    setUiModePreference("default");
    nextFrame();
    setUiModePreference("discord");
    nextFrame();
    expect(classes.has("no-transitions")).toBe(true);
    nextFrame();
    expect(classes.has("no-transitions")).toBe(false);
  });
});
