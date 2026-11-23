import { vi } from "vite-plus/test";

// Node unit tests replace Electron services. Importing the real package can
// download a runtime; tests that call Electron APIs supply their own mock.
vi.mock("electron", () => ({}));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
vi.mock("@clerk/electron", () => ({}));
vi.mock("@clerk/electron/storage", () => ({}));
