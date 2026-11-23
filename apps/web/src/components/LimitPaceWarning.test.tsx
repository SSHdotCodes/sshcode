import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: [] as unknown[],
  add: vi.fn((_toast: unknown) => "toast-1"),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../state/server", () => ({ primaryServerProvidersAtom: null }));
vi.mock("../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "24-hour" }),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, update: state.update, close: state.close },
}));
import { LimitPaceWarning } from "./LimitPaceWarning";

const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 10, 14, 1, 0).getTime();
let id = 0;
let instanceId = "";
let renderer: ReactTestRenderer;

const weekly = (usedPercent: number, resetsAt: number, recentPercentPerHour = 10) => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  recentPercentPerHour,
  resetsAt: new Date(resetsAt).toISOString(),
});
const provider = (windows: unknown[]) => ({
  instanceId,
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  usageLimits: { windows },
});

async function show(windows: unknown[]) {
  state.providers = [provider(windows)];
  await act(async () => {
    if (renderer) renderer.update(<LimitPaceWarning />);
    else renderer = create(<LimitPaceWarning />);
  });
}

beforeEach(() => {
  // The component remembers warnings per window for the page's lifetime.
  instanceId = `claude-${++id}`;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  renderer = undefined as unknown as ReactTestRenderer;
  vi.useRealTimers();
});

it("closes the warning once a reset reading no longer qualifies", async () => {
  await show([weekly(95, now + 3 * HOUR)]);
  expect(state.add).toHaveBeenCalledTimes(1);
  expect(state.add.mock.calls[0]![0]).toMatchObject({
    title: "Claude · Weekly: 95% used",
    description: "At the last hour's pace it runs out around 01:30.",
    timeout: 0,
  });
  await show([weekly(1, now + 7 * 24 * HOUR)]);
  expect(state.close).toHaveBeenCalledWith("toast-1");
  expect(state.add).toHaveBeenCalledTimes(1);
});

it("closes the warning when the provider stops reporting the window", async () => {
  await show([weekly(95, now + 3 * HOUR)]);
  await show([{ ...weekly(10, now + 3 * HOUR), id: "five_hour", label: "Session" }]);
  expect(state.close).toHaveBeenCalledWith("toast-1");
});

it("keeps the warning through a reading that carries no limits", async () => {
  await show([weekly(95, now + 3 * HOUR)]);
  // Warnings left open by earlier tests' providers close on this first reading.
  state.close.mockClear();
  await show([]);
  state.providers = [];
  await act(async () => renderer.update(<LimitPaceWarning />));
  expect(state.close).not.toHaveBeenCalled();
  expect(state.add).toHaveBeenCalledTimes(1);
});

it("stays up when the pace eases, and says the limit now lasts", async () => {
  await show([weekly(95, now + 3 * HOUR)]);
  // Warnings left open by earlier tests' providers close on this first reading.
  state.close.mockClear();
  await show([weekly(96, now + 3 * HOUR, 0.1)]);
  expect(state.close).not.toHaveBeenCalled();
  expect(state.update).toHaveBeenLastCalledWith("toast-1", {
    title: "Claude \u00b7 Weekly: 96% used",
    description: "At the last hour's pace it lasts until the reset.",
  });
});

it("closes the warning when the same period reads below the warning level", async () => {
  await show([weekly(95, now + 3 * HOUR)]);
  await show([weekly(40, now + 3 * HOUR)]);
  expect(state.close).toHaveBeenCalledWith("toast-1");
});

it("follows newer readings in place while the warning still applies", async () => {
  await show([weekly(90, now + 3 * HOUR)]);
  await show([weekly(95, now + 3 * HOUR + 20_000, 20)]);
  expect(state.add).toHaveBeenCalledTimes(1);
  expect(state.close).not.toHaveBeenCalled();
  expect(state.update).toHaveBeenCalledWith("toast-1", {
    title: "Claude · Weekly: 95% used",
    description: "At the last hour's pace it runs out around 01:15.",
  });
});

it("warns once per period, and again in the next one", async () => {
  await show([weekly(95, now + 3 * HOUR)]);
  await show([weekly(1, now + 7 * 24 * HOUR)]);
  await show([weekly(95, now + 3 * HOUR)]);
  expect(state.add).toHaveBeenCalledTimes(1);
  await show([weekly(95, now + HOUR)]);
  expect(state.add).toHaveBeenCalledTimes(2);
});
