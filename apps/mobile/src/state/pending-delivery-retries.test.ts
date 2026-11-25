import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createPendingDeliveryRetries } from "./pending-delivery-retries";

afterEach(() => vi.useRealTimers());

it("wakes a capped retry at reconnect and preserves the other environment's deadline", () => {
  vi.useFakeTimers();
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  const wake = vi.fn();
  const retries = createPendingDeliveryRetries(wake);
  retries.observeConnections(
    [a, b].map((environmentId) => ({ environmentId, connectionState: "connected" })),
  );
  for (const delay of [1000, 2000, 4000, 8000]) {
    for (const id of [a, b]) retries.onFailure(id, id)();
    vi.advanceTimersByTime(delay);
  }
  for (const id of [a, b]) retries.onFailure(id, id)();
  vi.advanceTimersByTime(1);
  retries.observeConnections([{ environmentId: b, connectionState: "connected" }]);
  retries.observeConnections(
    [a, b].map((environmentId) => ({ environmentId, connectionState: "connected" })),
  );
  expect(retries.waiting(a)).toBe(false);
  expect(retries.waiting(b)).toBe(true);
  vi.advanceTimersByTime(15999);
  expect(retries.waiting(b)).toBe(false);
  expect(wake).toHaveBeenCalledTimes(9);
});
